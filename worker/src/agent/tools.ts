// Agent tool surface. Read-only ops (read_file, list_dir, grep) hit the filesystem
// directly. Writes (write_file) emit *proposals* — the worker never modifies the
// workspace directly; the SPA renders the diff and the editor applies it via WorkspaceEdit.

import { exec as execCb } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { createTwoFilesPatch } from 'diff'
import { runShellCommand, formatTerminalResult } from './runTerminal.js'

const exec = promisify(execCb)

export type ToolDef = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type ToolHandler = (input: any, ctx: ToolCtx) => Promise<ToolResult>

// Approval request the run_terminal handler raises before executing. The
// transport (HTTP /api/agent/approve) lives in worker/src/server.ts.
export type ApprovalRequest = {
  tool: string
  command: string
  cwd?: string
}

export type ToolCtx = {
  workspaceRoot: string
  signal?: AbortSignal
  // Optional — when absent, run_terminal denies execution. Wired by
  // /api/agent/run; standalone calls to runTool() can leave it undefined.
  requestApproval?: (req: ApprovalRequest) => Promise<{ approved: boolean }>
}

export type ToolResult =
  | { kind: 'text'; summary: string; content: string; isError?: boolean }
  | { kind: 'diff'; path: string; oldContent: string; newContent: string; unifiedDiff: string }

// Resolve a workspace-relative path to an absolute path, refusing anything outside the root.
// This is the sandbox boundary — every file op routes through here.
function safePath(workspaceRoot: string, relPath: string): string {
  const root = path.resolve(workspaceRoot)
  const target = path.resolve(root, relPath)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path '${relPath}' resolves outside the workspace`)
  }
  return target
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. Path is workspace-relative.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List the entries (files + subdirectories) in a workspace-relative directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory path; "" for the root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep',
    description: 'Search the workspace for a regex pattern using ripgrep. Returns up to 200 matches.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Optional workspace-relative path to search in (defaults to whole workspace)' },
        glob: { type: 'string', description: 'Optional glob filter, e.g. "*.ts"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'write_file',
    description:
      'Propose a write to a file in the workspace. This does NOT change the file on disk — it emits a unified diff for the user to approve. After calling, assume the change has been proposed; do not call again for the same path unless revising.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to the file' },
        content: { type: 'string', description: 'Full new file contents' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_terminal',
    description:
      'Run a shell command in the workspace. The user must approve every command before it runs. Returns the exit code, stdout, and stderr. Use for tests, builds, package installs, git status — anything you would type at a terminal. Avoid commands that hang or wait for input.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run. Pipes, redirects, and shell expansions work (executed via sh -c).' },
        cwd: { type: 'string', description: 'Optional workspace-relative working directory; defaults to the workspace root.' },
        timeoutMs: { type: 'number', description: 'Optional per-command timeout in milliseconds. Default 60000.' },
      },
      required: ['command'],
    },
  },
]

const HANDLERS: Record<string, ToolHandler> = {
  read_file: async (input: { path: string }, ctx) => {
    const abs = safePath(ctx.workspaceRoot, input.path)
    const content = await fs.readFile(abs, 'utf8')
    const lines = content.split('\n').length
    return { kind: 'text', summary: `read ${input.path} (${lines} lines, ${content.length} bytes)`, content }
  },

  list_dir: async (input: { path: string }, ctx) => {
    const abs = safePath(ctx.workspaceRoot, input.path)
    const entries = await fs.readdir(abs, { withFileTypes: true })
    const lines = entries
      .filter((e) => !e.name.startsWith('.git') && e.name !== 'node_modules')
      .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
      .sort()
    return { kind: 'text', summary: `${lines.length} entries in ${input.path || '.'}`, content: lines.join('\n') }
  },

  grep: async (input: { pattern: string; path?: string; glob?: string }, ctx) => {
    const root = ctx.workspaceRoot
    const target = input.path ? safePath(root, input.path) : root
    const args = ['--json', '-S', '--no-ignore-vcs', '-g', '!node_modules', '-g', '!.git']
    if (input.glob) args.push('-g', input.glob)
    args.push(input.pattern, target)

    let stdout = ''
    try {
      const result = await exec(`rg ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`, {
        maxBuffer: 8 * 1024 * 1024,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      stdout = result.stdout
    } catch (err: any) {
      // ripgrep exits 1 when no matches — that's not an error from the agent's POV.
      if (err.code === 1) {
        return { kind: 'text', summary: '0 matches', content: '' }
      }
      throw err
    }

    const matches: string[] = []
    for (const line of stdout.split('\n')) {
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'match') {
          const rel = path.relative(root, obj.data.path.text)
          const lineNum = obj.data.line_number
          const text = obj.data.lines.text.replace(/\n$/, '')
          matches.push(`${rel}:${lineNum}: ${text}`)
        }
      } catch {
        continue
      }
    }
    const truncated = matches.slice(0, 200)
    const note = matches.length > 200 ? `\n… (${matches.length - 200} more truncated)` : ''
    return { kind: 'text', summary: `${matches.length} matches`, content: truncated.join('\n') + note }
  },

  run_terminal: async (input: { command: string; cwd?: string; timeoutMs?: number }, ctx) => {
    if (!ctx.requestApproval) {
      return {
        kind: 'text',
        summary: 'run_terminal not available in this context',
        content: 'Terminal execution requires a UI approval channel. This run is not eligible.',
        isError: true,
      }
    }
    const cwd = input.cwd ? safePath(ctx.workspaceRoot, input.cwd) : ctx.workspaceRoot
    const approval = await ctx.requestApproval({ tool: 'run_terminal', command: input.command, ...(input.cwd ? { cwd: input.cwd } : {}) })
    if (!approval.approved) {
      return {
        kind: 'text',
        summary: `command not approved: ${input.command}`,
        content: 'The user denied this command. Pick a different approach or explain what you wanted to run.',
        isError: true,
      }
    }
    const result = await runShellCommand(input.command, cwd, {
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    const summary = result.timedOut
      ? `\`${input.command}\` timed out`
      : result.exitCode === 0
        ? `\`${input.command}\` ok`
        : `\`${input.command}\` exit ${result.exitCode ?? `signal ${result.signal}`}`
    return {
      kind: 'text',
      summary,
      content: formatTerminalResult(input.command, result),
      ...(result.exitCode === 0 || result.timedOut ? {} : { isError: true }),
    }
  },

  write_file: async (input: { path: string; content: string }, ctx) => {
    const abs = safePath(ctx.workspaceRoot, input.path)
    let oldContent = ''
    try {
      oldContent = await fs.readFile(abs, 'utf8')
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
      // Treat creating-new-file as oldContent = ''.
    }
    const unifiedDiff = createTwoFilesPatch(`a/${input.path}`, `b/${input.path}`, oldContent, input.content, '', '')
    return {
      kind: 'diff',
      path: input.path,
      oldContent,
      newContent: input.content,
      unifiedDiff,
    }
  },
}

export function getToolDefs(): ToolDef[] {
  return TOOL_DEFS
}

export async function runTool(name: string, input: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const handler = HANDLERS[name]
  if (!handler) {
    return { kind: 'text', summary: `unknown tool: ${name}`, content: `No tool named '${name}' is registered.`, isError: true }
  }
  try {
    return await handler(input, ctx)
  } catch (err) {
    const message = (err as Error).message
    return { kind: 'text', summary: `error: ${message}`, content: message, isError: true }
  }
}
