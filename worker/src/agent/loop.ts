// ReAct-style tool-use loop. Drives a Provider.chat with the agent tool list.
// Yields events for the SSE stream: text/tool_use/tool_result/file_diff/iteration/done/error.

import type { AgentEvent, ChatMessage, EditorContext, ProviderConfig } from '@qbee/shared'
import { createProvider } from '../providers/index.js'
import { getToolDefs, runTool, type ApprovalRequest, type ToolResult } from './tools.js'
import { formatEditorContext } from '../editorContext.js'

const SYSTEM_PROMPT = `You are QBee, a coding agent embedded in the user's editor. The user's workspace is open and you have tools to read, search, run, and propose edits to files.

Tool usage rules:
- Always use \`read_file\` before proposing a change to a file you have not seen.
- Use \`grep\` to find relevant code. Prefer specific patterns over broad ones.
- Use \`list_dir\` to orient yourself in unfamiliar parts of the tree.
- \`write_file\` does NOT modify the file on disk. It produces a diff for the user to review and approve. Do not call \`write_file\` more than once for the same path in one turn unless you are revising a prior proposal.
- \`run_terminal\` requires the user to approve every command before it runs. Each call pauses the loop for confirmation. Use it for tests, builds, package installs, lints, git status — not for things that hang or wait for input. Avoid commands that watch (use one-shot flags). If a command is denied, pick a different approach or ask the user what they prefer.
- Paths are workspace-relative.
- Stop and explain when you have enough information; do not call tools you do not need.

Be concise. Walk the user through what you found before showing diffs. When the work is done, summarize what changed and what they should review.`

export type AgentLoopOptions = {
  providerConfig: ProviderConfig
  initialMessages: ChatMessage[]
  workspaceRoot: string
  maxIterations: number
  signal?: AbortSignal
  getApiKey: (ref: string) => Promise<string | undefined>
  editorContext?: EditorContext
  // Optional: how the run_terminal tool gates user approval. When omitted,
  // run_terminal returns an isError result (denied by default).
  requestApproval?: (req: ApprovalRequest) => Promise<{ approved: boolean }>
}

export async function* runAgent(opts: AgentLoopOptions): AsyncIterable<AgentEvent> {
  const provider = createProvider(opts.providerConfig, opts.getApiKey)
  const toolDefs = getToolDefs()
  const editorContextBlock = formatEditorContext(opts.editorContext)
  const systemContent = editorContextBlock
    ? `${SYSTEM_PROMPT}\n\nThe user is currently looking at:\n${editorContextBlock}`
    : SYSTEM_PROMPT
  const messages: ChatMessage[] = [{ role: 'system', content: systemContent }, ...opts.initialMessages]

  for (let i = 0; i < opts.maxIterations; i++) {
    if (opts.signal?.aborted) {
      yield { type: 'done', reason: 'cancelled' }
      return
    }
    yield { type: 'iteration', index: i }

    const accumulatedText: string[] = []
    const accumulatedToolUses: { id: string; name: string; input: unknown }[] = []
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown' | undefined

    try {
      for await (const evt of provider.chat({
        messages,
        tools: toolDefs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })) {
        if (evt.type === 'text') {
          accumulatedText.push(evt.value)
          yield { type: 'text', value: evt.value }
        } else if (evt.type === 'tool_use') {
          accumulatedToolUses.push({ id: evt.id, name: evt.name, input: evt.input })
          yield { type: 'tool_use', id: evt.id, name: evt.name, input: evt.input }
        } else if (evt.type === 'error') {
          yield { type: 'error', message: evt.message }
          return
        } else if (evt.type === 'done') {
          stopReason = evt.stopReason
        }
      }
    } catch (err) {
      yield { type: 'error', message: (err as Error).message }
      return
    }

    // Persist what the assistant just said (text + the tool_use blocks it produced).
    messages.push({
      role: 'assistant',
      content: accumulatedText.join(''),
      ...(accumulatedToolUses.length > 0 ? { toolCalls: accumulatedToolUses } : {}),
    })

    if (accumulatedToolUses.length === 0) {
      // No tool calls — model is done talking.
      yield { type: 'done', reason: stopReason === 'max_tokens' ? 'max_iterations' : 'end_turn' }
      return
    }

    // Execute each tool call, append a tool_result message per call.
    for (const tc of accumulatedToolUses) {
      if (opts.signal?.aborted) {
        yield { type: 'done', reason: 'cancelled' }
        return
      }
      const result = await runTool(tc.name, tc.input, {
        workspaceRoot: opts.workspaceRoot,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.requestApproval ? { requestApproval: opts.requestApproval } : {}),
      })

      yield* renderToolResult(tc, result)
      messages.push(toolResultMessage(tc.id, result))
    }
  }

  yield { type: 'done', reason: 'max_iterations' }
}

function* renderToolResult(tc: { id: string; name: string }, result: ToolResult): Generator<AgentEvent> {
  if (result.kind === 'diff') {
    yield {
      type: 'tool_result',
      id: tc.id,
      name: tc.name,
      summary: `proposed write to ${result.path} (+${result.newContent.split('\n').length}/-${result.oldContent.split('\n').length} lines)`,
    }
    yield {
      type: 'file_diff',
      path: result.path,
      unifiedDiff: result.unifiedDiff,
      oldContent: result.oldContent,
      newContent: result.newContent,
    }
  } else {
    yield {
      type: 'tool_result',
      id: tc.id,
      name: tc.name,
      summary: result.summary,
      ...(result.isError ? { isError: true } : {}),
    }
  }
}

function toolResultMessage(toolUseId: string, result: ToolResult): ChatMessage {
  if (result.kind === 'diff') {
    // Tell the model the proposal was created. Keep payload short — full content already in context from write_file input.
    return {
      role: 'tool',
      toolCallId: toolUseId,
      content: `Proposed write to ${result.path} created. Awaiting user review.`,
    }
  }
  return {
    role: 'tool',
    toolCallId: toolUseId,
    content: result.isError ? `Error: ${result.content}` : result.content,
  }
}
