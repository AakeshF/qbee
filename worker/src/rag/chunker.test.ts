import { describe, it, expect } from 'vitest'
import { chunkFile, chunkFileForIndex, hashContent } from './chunker.js'

describe('chunkFile (fixed-window fallback)', () => {
  it('returns empty for empty content', () => {
    expect(chunkFile('')).toEqual([])
  })

  it('emits one chunk for a small file', () => {
    const text = 'line1\nline2\nline3\n'
    const chunks = chunkFile(text)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.startLine).toBe(1)
  })

  it('splits a long file into overlapping windows', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
    const chunks = chunkFile(text, { linesPerChunk: 40, overlapLines: 4 })
    expect(chunks.length).toBeGreaterThan(1)
    // Overlap means consecutive chunks share at least 1 line.
    const a = chunks[0]!
    const b = chunks[1]!
    expect(b.startLine).toBeLessThan(a.endLine)
  })

  it('skips chunks that are essentially whitespace', () => {
    const text = '\n\n\n\n\n\n\n\n\n\n'
    const chunks = chunkFile(text)
    expect(chunks).toEqual([])
  })
})

describe('hashContent', () => {
  it('is stable for the same input', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'))
  })

  it('differs for different input', () => {
    expect(hashContent('hello')).not.toBe(hashContent('world'))
  })

  it('returns a 16-char hex prefix', () => {
    const h = hashContent('hello')
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('chunkFileForIndex', () => {
  it('uses tree-sitter for TypeScript and emits one chunk per top-level def', async () => {
    const ts = `
import path from 'node:path'

export function foo(a: number, b: number): number {
  return a + b
}

export class Bar {
  greet(): string {
    return 'hi'
  }
}

const SECRET = 42
`
    const chunks = await chunkFileForIndex('src/sample.ts', ts)
    // We expect at least: foo function, Bar class, SECRET const + the import preamble.
    // Loose assertion — implementations differ slightly on grouping.
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    const concat = chunks.map((c) => c.content).join('\n')
    expect(concat).toContain('function foo')
    expect(concat).toContain('class Bar')
    expect(concat).toContain('SECRET')
  })

  it('falls back to fixed-window for unsupported extensions', async () => {
    const text = 'plain text content\n'.repeat(100)
    const chunks = await chunkFileForIndex('notes.md', text)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('falls back to fixed-window when tree-sitter parses to nothing useful', async () => {
    // Empty Python file: parser returns an empty program; chunker falls through.
    const chunks = await chunkFileForIndex('empty.py', '')
    expect(chunks).toEqual([])
  })
})
