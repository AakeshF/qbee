// Incremental RAG reindex via chokidar. Watches the workspace; on file change
// re-chunks the affected file and replaces its rows in the store; on delete
// drops them. 500ms per-file debounce because IDE saves often arrive as a
// burst of writes.

import path from 'node:path'
import { promises as fs } from 'node:fs'
import chokidar, { type FSWatcher } from 'chokidar'
import ignoreFactory, { type Ignore } from 'ignore'
import type { Provider } from '../providers/types.js'
import type { Chunk, RagStore } from './store.js'
import { chunkFileForIndex, hashContent } from './chunker.js'

const ignoreFn = ignoreFactory as unknown as () => Ignore

const HARD_SKIP = ['**/node_modules/**', '**/.git/**', '**/.qbee/**', '**/dist/**', '**/build/**', '**/out/**', '**/.next/**', '**/.cache/**', '**/.parcel-cache/**']
const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.php', '.java', '.kt', '.scala', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.fish',
  '.md', '.txt', '.rst',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss',
  '.sql', '.proto', '.graphql', '.gql',
])
const MAX_FILE_BYTES = 256 * 1024
const DEBOUNCE_MS = 500

export type WatcherOptions = {
  workspaceRoot: string
  store: RagStore
  embeddingProvider: Provider
  embeddingDim: number
  log?: (msg: string, data?: unknown) => void
}

export class RagWatcher {
  private watcher: FSWatcher | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private ig: Ignore | null = null

  constructor(private readonly opts: WatcherOptions) {}

  async start(): Promise<void> {
    if (this.watcher) return
    this.ig = await loadIgnore(this.opts.workspaceRoot)

    this.watcher = chokidar.watch(this.opts.workspaceRoot, {
      ignored: HARD_SKIP,
      ignoreInitial: true, // /api/rag/index already covered the initial pass
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })

    this.watcher.on('add', (full) => this.queue(full))
    this.watcher.on('change', (full) => this.queue(full))
    this.watcher.on('unlink', (full) => this.handleUnlink(full))

    this.opts.log?.('rag-watcher: started', { workspaceRoot: this.opts.workspaceRoot })
  }

  async stop(): Promise<void> {
    if (!this.watcher) return
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    await this.watcher.close()
    this.watcher = null
  }

  private queue(fullPath: string): void {
    if (!this.shouldHandle(fullPath)) return
    const existing = this.timers.get(fullPath)
    if (existing) clearTimeout(existing)
    this.timers.set(
      fullPath,
      setTimeout(() => {
        this.timers.delete(fullPath)
        this.reindexOne(fullPath).catch((err) => this.opts.log?.('rag-watcher: reindex failed', { fullPath, err: (err as Error).message }))
      }, DEBOUNCE_MS),
    )
  }

  private handleUnlink(fullPath: string): void {
    if (!this.shouldHandle(fullPath)) return
    const rel = path.relative(this.opts.workspaceRoot, fullPath)
    this.opts.store.removeFile(rel)
    this.opts.log?.('rag-watcher: removed', { rel })
  }

  private shouldHandle(fullPath: string): boolean {
    if (!fullPath.startsWith(this.opts.workspaceRoot)) return false
    const ext = path.extname(fullPath).toLowerCase()
    if (!TEXT_EXTS.has(ext)) return false
    const rel = path.relative(this.opts.workspaceRoot, fullPath)
    if (this.ig?.ignores(rel)) return false
    return true
  }

  private async reindexOne(fullPath: string): Promise<void> {
    const rel = path.relative(this.opts.workspaceRoot, fullPath)
    let stat
    try {
      stat = await fs.stat(fullPath)
    } catch {
      // File vanished between debounce and now.
      this.opts.store.removeFile(rel)
      return
    }
    if (stat.size > MAX_FILE_BYTES) return
    const content = await fs.readFile(fullPath, 'utf8')

    const raw = await chunkFileForIndex(rel, content)
    if (raw.length === 0) {
      this.opts.store.removeFile(rel)
      return
    }
    const result = await this.opts.embeddingProvider.embed(raw.map((c) => c.content))
    if (result.dim !== this.opts.embeddingDim) {
      this.opts.log?.('rag-watcher: dim mismatch', { got: result.dim, expected: this.opts.embeddingDim })
      return
    }
    const mtime = Math.floor(stat.mtimeMs)
    const chunks: Chunk[] = raw.map((c) => ({
      filePath: rel,
      startLine: c.startLine,
      endLine: c.endLine,
      content: c.content,
      language: extToLang(path.extname(rel)),
      mtime,
      contentHash: hashContent(c.content),
    }))
    this.opts.store.replaceFile(rel, chunks, result.vectors)
    this.opts.log?.('rag-watcher: reindexed', { rel, chunks: chunks.length })
  }
}

async function loadIgnore(root: string): Promise<Ignore> {
  const ig = ignoreFn()
  try {
    ig.add(await fs.readFile(path.join(root, '.gitignore'), 'utf8'))
  } catch { /* optional */ }
  try {
    ig.add(await fs.readFile(path.join(root, '.qbeeignore'), 'utf8'))
  } catch { /* optional */ }
  return ig
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
