import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runTool } from './tools.js'

let workspaceRoot: string

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qbee-tool-test-'))
  await fs.writeFile(path.join(workspaceRoot, 'foo.ts'), 'const x = 1\nconst y = 2\n', 'utf8')
  await fs.mkdir(path.join(workspaceRoot, 'sub'))
  await fs.writeFile(path.join(workspaceRoot, 'sub', 'bar.ts'), 'export const z = 3\n', 'utf8')
})

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true })
})

describe('read_file tool', () => {
  it('reads a workspace-relative file', async () => {
    const result = await runTool('read_file', { path: 'foo.ts' }, { workspaceRoot })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.content).toContain('const x = 1')
      expect(result.summary).toContain('foo.ts')
      expect(result.isError).toBeUndefined()
    }
  })

  it('returns an isError result for missing files', async () => {
    const result = await runTool('read_file', { path: 'does-not-exist.ts' }, { workspaceRoot })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.isError).toBe(true)
    }
  })

  it('refuses paths that escape the workspace', async () => {
    const result = await runTool('read_file', { path: '../etc/passwd' }, { workspaceRoot })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/outside the workspace/)
    }
  })
})

describe('list_dir tool', () => {
  it('lists root entries', async () => {
    const result = await runTool('list_dir', { path: '' }, { workspaceRoot })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.content).toContain('foo.ts')
      expect(result.content).toContain('sub')
    }
  })

  it('lists subdirectory entries', async () => {
    const result = await runTool('list_dir', { path: 'sub' }, { workspaceRoot })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.content).toContain('bar.ts')
    }
  })
})

describe('write_file tool', () => {
  it('produces a unified diff WITHOUT modifying disk', async () => {
    const original = await fs.readFile(path.join(workspaceRoot, 'foo.ts'), 'utf8')
    const result = await runTool('write_file', {
      path: 'foo.ts',
      content: 'const x = 999\nconst y = 2\n',
    }, { workspaceRoot })
    expect(result.kind).toBe('diff')
    if (result.kind === 'diff') {
      expect(result.path).toBe('foo.ts')
      expect(result.unifiedDiff).toContain('const x = 1')
      expect(result.unifiedDiff).toContain('const x = 999')
      expect(result.newContent).toContain('999')
    }
    // Disk untouched — invariant of the agent surface.
    const after = await fs.readFile(path.join(workspaceRoot, 'foo.ts'), 'utf8')
    expect(after).toBe(original)
  })

  it('handles new-file proposals (oldContent empty)', async () => {
    const result = await runTool('write_file', {
      path: 'new-file.ts',
      content: 'export const fresh = true\n',
    }, { workspaceRoot })
    expect(result.kind).toBe('diff')
    if (result.kind === 'diff') {
      expect(result.oldContent).toBe('')
      expect(result.newContent).toContain('fresh = true')
    }
  })
})

describe('run_terminal tool', () => {
  it('returns isError when no approval channel is provided (denied by default)', async () => {
    const result = await runTool('run_terminal', { command: 'echo hi' }, { workspaceRoot })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.isError).toBe(true)
    }
  })

  it('runs the command when approved', async () => {
    const result = await runTool('run_terminal', { command: 'echo hi' }, {
      workspaceRoot,
      requestApproval: async () => ({ approved: true }),
    })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.isError).toBeUndefined()
      expect(result.content).toContain('hi')
      expect(result.summary).toContain('ok')
    }
  })

  it('returns isError when the user denies', async () => {
    const result = await runTool('run_terminal', { command: 'echo hi' }, {
      workspaceRoot,
      requestApproval: async () => ({ approved: false }),
    })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.isError).toBe(true)
      expect(result.content).toContain('denied')
    }
  })
})

describe('unknown tool', () => {
  it('returns a clear error for an unknown name', async () => {
    const result = await runTool('does_not_exist', {}, { workspaceRoot })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.isError).toBe(true)
      expect(result.summary).toContain('unknown tool')
    }
  })
})
