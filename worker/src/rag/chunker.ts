// Chunker. For supported source languages, parses with tree-sitter and emits
// one chunk per top-level definition (function/class/etc.). For everything
// else, falls back to fixed-window line-based chunking.
//
// Tree-sitter chunking lives in ./treeSitterChunker.ts; this module is the
// public entry point and the fixed-window fallback.

import { createHash } from 'node:crypto'
import path from 'node:path'
import { isTreeSitterSupported, treeSitterChunk } from './treeSitterChunker.js'

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

export async function chunkFileForIndex(filePath: string, content: string): Promise<RawChunk[]> {
  const ext = path.extname(filePath)
  if (isTreeSitterSupported(ext)) {
    const tsChunks = await treeSitterChunk(content, ext)
    if (tsChunks && tsChunks.length > 0) return tsChunks
    // Parse failed or returned empty — fall through to fixed-window so we
    // still get retrieval coverage on the file.
  }
  return chunkFile(content)
}

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
