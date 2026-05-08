import { describe, it, expect } from 'vitest'
import { ChatRequest, EditorContext, AgentEvent, RagProbeResponse, ApproveToolRequest } from './api.js'

describe('ChatRequest schema', () => {
  it('accepts a minimal valid request', () => {
    const result = ChatRequest.safeParse({
      provider: { id: 'openai-compatible', model: 'qwen2.5-coder:7b', baseUrl: 'http://127.0.0.1:11434/v1' },
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.success).toBe(true)
  })

  it('accepts an optional editorContext', () => {
    const result = ChatRequest.safeParse({
      provider: { id: 'anthropic', model: 'claude-sonnet-4-5', apiKeyRef: 'ANTHROPIC_API_KEY' },
      messages: [{ role: 'user', content: 'what is this' }],
      editorContext: {
        activeFile: 'src/foo.ts',
        selection: { startLine: 0, endLine: 5, text: 'function foo() {}' },
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown provider id', () => {
    const result = ChatRequest.safeParse({
      provider: { id: 'unknown', model: 'x' },
      messages: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects baseUrl that is not a URL', () => {
    const result = ChatRequest.safeParse({
      provider: { id: 'openai-compatible', model: 'x', baseUrl: 'not-a-url' },
      messages: [],
    })
    expect(result.success).toBe(false)
  })
})

describe('EditorContext schema', () => {
  it('accepts an empty object', () => {
    expect(EditorContext.safeParse({}).success).toBe(true)
  })

  it('caps openFiles at 50', () => {
    const fiftyOne = Array.from({ length: 51 }, (_, i) => `f${i}.ts`)
    const result = EditorContext.safeParse({ openFiles: fiftyOne })
    expect(result.success).toBe(false)
  })
})

describe('AgentEvent discriminated union', () => {
  it('accepts an awaiting_approval event', () => {
    const result = AgentEvent.safeParse({
      type: 'awaiting_approval',
      approvalId: 'appr-123',
      tool: 'run_terminal',
      command: 'npm test',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a tool_use without an id', () => {
    const result = AgentEvent.safeParse({
      type: 'tool_use',
      name: 'read_file',
      input: { path: 'foo.ts' },
    })
    expect(result.success).toBe(false)
  })
})

describe('RagProbeResponse schema', () => {
  it('accepts ok with a dim', () => {
    expect(RagProbeResponse.safeParse({ ok: true, dim: 768 }).success).toBe(true)
  })

  it('accepts not-ok with an error', () => {
    expect(RagProbeResponse.safeParse({ ok: false, error: 'connection refused' }).success).toBe(true)
  })

  it('rejects ok with a non-positive dim', () => {
    expect(RagProbeResponse.safeParse({ ok: true, dim: 0 }).success).toBe(false)
  })
})

describe('ApproveToolRequest schema', () => {
  it('round-trips approval and denial', () => {
    expect(ApproveToolRequest.safeParse({ approvalId: 'a', approved: true }).success).toBe(true)
    expect(ApproveToolRequest.safeParse({ approvalId: 'a', approved: false }).success).toBe(true)
  })
})
