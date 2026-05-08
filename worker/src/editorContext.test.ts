import { describe, it, expect } from 'vitest'
import { formatEditorContext } from './editorContext.js'

describe('formatEditorContext', () => {
  it('returns null for undefined input', () => {
    expect(formatEditorContext(undefined)).toBeNull()
  })

  it('returns null when no fields are present', () => {
    expect(formatEditorContext({})).toBeNull()
  })

  it('formats just an active file', () => {
    const out = formatEditorContext({ activeFile: 'src/foo.ts' })
    expect(out).toContain('<editor_state>')
    expect(out).toContain('active_file: src/foo.ts')
    expect(out).toContain('</editor_state>')
  })

  it('appends 1-based cursor line when present', () => {
    const out = formatEditorContext({ activeFile: 'src/foo.ts', cursorLine: 41 })
    expect(out).toContain('active_file: src/foo.ts:42')
  })

  it('formats a selection with code fence', () => {
    const out = formatEditorContext({
      activeFile: 'src/foo.ts',
      selection: { startLine: 9, endLine: 13, text: 'function foo() {\n  return 1\n}' },
    })
    expect(out).toContain('selection: lines 10-14')
    expect(out).toContain('```')
    expect(out).toContain('function foo() {')
  })

  it('truncates oversized selections', () => {
    const big = 'x'.repeat(20_000)
    const out = formatEditorContext({
      activeFile: 'src/big.ts',
      selection: { startLine: 0, endLine: 999, text: big },
    })
    expect(out).toContain('[truncated]')
  })

  it('formats open files with a cap and remainder count', () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`)
    const out = formatEditorContext({ openFiles: many })
    // First 20 plus an indicator of the remaining 5.
    expect(out).toContain('open_files:')
    expect(out).toContain('+5 more')
  })
})
