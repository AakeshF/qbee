// Fixed-window chunker. Tree-sitter granularity is on the Phase 5+ wishlist; for now
// we cut by line count with overlap. Works for every text file regardless of language.

import { createHash } from 'node:crypto'

export type RawChunk = {
  startLine: number
  endLine: number
  content: string
}

export type ChunkOptions = {
  // Approximate target lines per chunk. Hand-tuned for 768-dim embeddings:
  // ~40 lines is roughly 200-400 tokens, the sweet spot for code retrieval.
  linesPerChunk: number
  overlapLines: number
}

const DEFAULT_OPTS: ChunkOptions = { linesPerChunk: 40, overlapLines: 4 }

export function chunkFile(content: string, opts: Partial<ChunkOptions> = {}): RawChunk[] {
  const { linesPerChunk, overlapLines } = { ...DEFAULT_OPTS, ...opts }
  const lines = content.split('\n')
  if (lines.length === 0) return []

  const chunks: RawChunk[] = []
  const step = Math.max(1, linesPerChunk - overlapLines)
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + linesPerChunk)
    const slice = lines.slice(start, end)
    // Skip pure-whitespace chunks — embedding them is wasteful and hurts retrieval.
    if (slice.join('').trim().length < 8) continue
    chunks.push({
      startLine: start + 1,
      endLine: end,
      content: slice.join('\n'),
    })
    if (end === lines.length) break
  }
  return chunks
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}
