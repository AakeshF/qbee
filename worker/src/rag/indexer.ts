// Walk the workspace, chunk each file, embed in batches, persist via RagStore.
// Respects .gitignore via the `ignore` package, plus a hardcoded short skip-list
// for paths that are never useful (node_modules, .git, dist, build, .qbee itself).

import { promises as fs } from 'node:fs'
import path from 'node:path'
import ignoreModule from 'ignore'
import type { Ignore } from 'ignore'

// `ignore` is a CJS package whose default export is the factory function. Under
// verbatimModuleSyntax + NodeNext, TS can't see that — cast to make the call work.
const ignoreFactory = ignoreModule as unknown as () => Ignore
import type { Provider } from '../providers/types.js'
import type { Chunk, RagStore } from './store.js'
import { chunkFile, hashContent } from './chunker.js'

const HARD_SKIP = new Set(['node_modules', '.git', '.qbee', 'dist', 'build', 'out', '.next', '.cache', '.parcel-cache'])
const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.php', '.java', '.kt', '.scala', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.fish',
  '.md', '.txt', '.rst',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss',
  '.sql', '.proto', '.graphql', '.gql',
])
const MAX_FILE_BYTES = 256 * 1024 // skip lockfiles and other junk

export type IndexProgress =
  | { type: 'walking' }
  | { type: 'discovered'; count: number }
  | { type: 'file'; path: string; index: number; total: number }
  | { type: 'embedded'; chunkCount: number }
  | { type: 'done'; files: number; chunks: number; tookMs: number }
  | { type: 'error'; message: string }

export type IndexOptions = {
  workspaceRoot: string
  store: RagStore
  embeddingProvider: Provider
  embeddingDim: number
  embeddingBatchSize?: number
  signal?: AbortSignal
}

export async function* indexWorkspace(opts: IndexOptions): AsyncIterable<IndexProgress> {
  const start = Date.now()
  const ig = await loadIgnore(opts.workspaceRoot)

  yield { type: 'walking' }
  const files = await walkFiles(opts.workspaceRoot, ig)
  yield { type: 'discovered', count: files.length }

  let totalChunks = 0
  const batchSize = opts.embeddingBatchSize ?? 32

  for (let i = 0; i < files.length; i++) {
    if (opts.signal?.aborted) {
      yield { type: 'error', message: 'cancelled' }
      return
    }
    const filePath = files[i]!
    yield { type: 'file', path: filePath, index: i, total: files.length }

    let content: string
    let mtime: number
    try {
      const stat = await fs.stat(path.join(opts.workspaceRoot, filePath))
      if (stat.size > MAX_FILE_BYTES) continue
      mtime = Math.floor(stat.mtimeMs)
      content = await fs.readFile(path.join(opts.workspaceRoot, filePath), 'utf8')
    } catch {
      continue
    }

    const raw = chunkFile(content)
    if (raw.length === 0) continue

    // Embed in fixed-size batches so we don't blow up on huge files.
    const chunks: Chunk[] = []
    const embeddings: number[][] = []
    for (let j = 0; j < raw.length; j += batchSize) {
      const slice = raw.slice(j, j + batchSize)
      let result
      try {
        result = await opts.embeddingProvider.embed(slice.map((c) => c.content))
      } catch (err) {
        yield { type: 'error', message: `embed failed for ${filePath}: ${(err as Error).message}` }
        return
      }
      if (result.dim !== opts.embeddingDim) {
        yield { type: 'error', message: `embedding dim mismatch (got ${result.dim}, expected ${opts.embeddingDim})` }
        return
      }
      for (let k = 0; k < slice.length; k++) {
        const c = slice[k]!
        chunks.push({
          filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          content: c.content,
          language: extToLang(path.extname(filePath)),
          mtime,
          contentHash: hashContent(c.content),
        })
        embeddings.push(result.vectors[k]!)
      }
    }

    opts.store.replaceFile(filePath, chunks, embeddings)
    totalChunks += chunks.length
    yield { type: 'embedded', chunkCount: chunks.length }
  }

  opts.store.setMeta('lastIndexed', String(Date.now()))
  yield { type: 'done', files: files.length, chunks: totalChunks, tookMs: Date.now() - start }
}

async function loadIgnore(root: string) {
  const ig = ignoreFactory()
  try {
    const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    ig.add(gitignore)
  } catch {
    /* no .gitignore is fine */
  }
  try {
    const qbeeignore = await fs.readFile(path.join(root, '.qbeeignore'), 'utf8')
    ig.add(qbeeignore)
  } catch {
    /* optional */
  }
  return ig
}

async function walkFiles(root: string, ig: Ignore): Promise<string[]> {
  const out: string[] = []
  async function walk(rel: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (HARD_SKIP.has(e.name)) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (ig.ignores(e.isDirectory() ? `${childRel}/` : childRel)) continue
      if (e.isDirectory()) {
        await walk(childRel)
      } else if (e.isFile()) {
        if (TEXT_EXTS.has(path.extname(e.name).toLowerCase())) {
          out.push(childRel)
        }
      }
    }
  }
  await walk('')
  return out
}

function extToLang(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
    '.java': 'java', '.kt': 'kotlin', '.scala': 'scala', '.swift': 'swift',
    '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
    '.md': 'markdown', '.txt': 'plain', '.rst': 'rst',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.xml': 'xml', '.html': 'html', '.css': 'css', '.scss': 'scss',
    '.sql': 'sql', '.proto': 'proto', '.graphql': 'graphql', '.gql': 'graphql',
  }
  return map[ext.toLowerCase()] ?? 'plain'
}
