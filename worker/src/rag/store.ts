// SQLite-backed RAG store. One DB per workspace at <workspaceRoot>/.qbee/index.sqlite.
// Three tables: chunks (rich rows), chunks_vec (sqlite-vec virtual), chunks_fts (FTS5).
// `meta` records the embedding model + dim + chunker_version so we can reject
// stale indexes when any of those change.

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

// Bump this whenever the chunking strategy changes such that existing chunks
// would not be reproduced byte-for-byte by re-running the chunker. On open,
// we wipe and force a re-index when meta.chunker_version drifts.
//   1 — fixed-window line chunker (40 lines, 4 overlap)
//   2 — tree-sitter chunker for supported langs, fixed-window fallback
export const CHUNKER_VERSION = 2

export type Chunk = {
  id?: number
  filePath: string
  startLine: number
  endLine: number
  content: string
  language: string
  mtime: number
  contentHash: string
}

export type SearchHit = {
  chunkId: number
  filePath: string
  startLine: number
  endLine: number
  content: string
  score: number
}

export class RagStore {
  private db: Database.Database
  private dim: number

  constructor(private readonly workspaceRoot: string, dim: number) {
    const dir = path.join(workspaceRoot, '.qbee')
    mkdirSync(dir, { recursive: true })
    const dbPath = path.join(dir, 'index.sqlite')
    this.db = new Database(dbPath)
    this.dim = dim

    sqliteVec.load(this.db)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        language TEXT,
        mtime INTEGER NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, content='chunks', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `)

    // Vector table — dim is fixed at create time. If meta.dim differs from current model,
    // the caller should bump it (rebuilds the table). We bind via implicit rowid (matched
    // to chunks.id) rather than a named INTEGER PRIMARY KEY column, because vec0's
    // PRIMARY KEY accepts only true SQLite INTEGER values and rejects JS numbers under
    // some better-sqlite3 binding paths ("Only integers are allows for primary key values").
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding FLOAT[${dim}])`)

    this.setMeta('dim', String(dim))

    // Invalidate stale chunks if the chunker has been upgraded since this DB
    // was last written. We don't drop the schema — just clear the rows so a
    // re-index repopulates with the new chunk shape.
    const recordedChunker = this.getMeta('chunker_version')
    if (recordedChunker !== String(CHUNKER_VERSION)) {
      this.db.exec(`DELETE FROM chunks_vec; DELETE FROM chunks; DELETE FROM chunks_fts;`)
      this.setMeta('chunker_version', String(CHUNKER_VERSION))
    }
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  // Wipe and recreate vector + FTS tables when dim or model changes.
  resetForDim(newDim: number): void {
    this.db.exec(`DROP TABLE IF EXISTS chunks_vec`)
    this.db.exec(`CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding FLOAT[${newDim}])`)
    this.db.exec(`DELETE FROM chunks; DELETE FROM chunks_fts;`)
    this.dim = newDim
    this.setMeta('dim', String(newDim))
  }

  // Replace all chunks for a file with the given new chunks + their embeddings.
  // Tx wraps both the chunks insert and the vec insert so the index never lands half-applied.
  replaceFile(filePath: string, chunks: Chunk[], embeddings: number[][]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunks_vec WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)').run(filePath)
      this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath)
      const insertChunk = this.db.prepare(
        'INSERT INTO chunks (file_path, start_line, end_line, content, language, mtime, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      // Bind to vec0's implicit rowid so the row ID matches chunks.id 1:1.
      const insertVec = this.db.prepare('INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)')
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!
        const e = embeddings[i]!
        if (e.length !== this.dim) {
          throw new Error(`embedding dim ${e.length} != store dim ${this.dim} for ${filePath}`)
        }
        const result = insertChunk.run(c.filePath, c.startLine, c.endLine, c.content, c.language, c.mtime, c.contentHash)
        // Bind as BigInt so SQLite stores it as INTEGER (not REAL). vec0's primary key
        // rejects REAL values with the cryptic message "Only integers are allows for primary key values".
        insertVec.run(BigInt(result.lastInsertRowid), Buffer.from(new Float32Array(e).buffer))
      }
    })
    tx()
  }

  removeFile(filePath: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunks_vec WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)').run(filePath)
      this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath)
    })
    tx()
  }

  searchVector(queryEmbedding: number[], topK: number): SearchHit[] {
    if (queryEmbedding.length !== this.dim) {
      throw new Error(`query embedding dim ${queryEmbedding.length} != store dim ${this.dim}`)
    }
    const buf = Buffer.from(new Float32Array(queryEmbedding).buffer)
    const rows = this.db
      .prepare(
        `SELECT c.id, c.file_path, c.start_line, c.end_line, c.content, v.distance
         FROM chunks_vec v JOIN chunks c ON c.id = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`,
      )
      .all(buf, topK) as Array<{ id: number; file_path: string; start_line: number; end_line: number; content: string; distance: number }>
    return rows.map((r) => ({
      chunkId: r.id,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      // Convert distance → similarity score (smaller distance = higher score).
      score: 1 / (1 + r.distance),
    }))
  }

  searchBM25(query: string, topK: number): SearchHit[] {
    // FTS5 needs the query to be a token expression; quote special chars.
    const safe = query.replace(/"/g, '""')
    const rows = this.db
      .prepare(
        `SELECT c.id, c.file_path, c.start_line, c.end_line, c.content, bm25(chunks_fts) AS score
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(`"${safe}"`, topK) as Array<{ id: number; file_path: string; start_line: number; end_line: number; content: string; score: number }>
    return rows.map((r) => ({
      chunkId: r.id,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      // BM25 returns a NEGATIVE score (lower = better); negate for "higher = better" elsewhere.
      score: -r.score,
    }))
  }

  totalChunks(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM chunks').get() as { n: number }
    return row.n
  }

  filesIndexed(): number {
    const row = this.db.prepare('SELECT COUNT(DISTINCT file_path) as n FROM chunks').get() as { n: number }
    return row.n
  }

  close(): void {
    this.db.close()
  }
}
