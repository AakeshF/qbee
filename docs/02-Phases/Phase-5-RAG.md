# Phase 5 — RAG / @codebase

**Goal:** `@codebase what handles auth?` returns relevant code snippets via semantic search over the indexed workspace.

**Demo at end:** index a 10k-file repo. Query semantic + lexical search. Hybrid retrieval returns top-K chunks under 500ms.

## Tasks

### Worker
- [ ] `worker/src/rag/store.ts` — `better-sqlite3` + `sqlite-vec` extension, schema:
  - `chunks(id, file_path, start_line, end_line, content, language, mtime)`
  - `chunk_vec` (sqlite-vec virtual table, dim = embedding model dim, e.g. 768 for nomic-embed-text)
  - `chunks_fts` (FTS5 virtual table on `content` for BM25)
- [ ] `worker/src/rag/chunker.ts` — Tree-sitter splitting: function/class/method granularity, fallback to fixed 400-token windows for unsupported languages
- [ ] `worker/src/rag/indexer.ts` — full and incremental:
  - Full: walk workspace, chunk, embed in batches of 64, upsert
  - Incremental: `chokidar` watches; on change → re-chunk → embed → upsert; on delete → drop
  - Respect `.gitignore`, plus a `.qbeeignore` for index-specific excludes
- [ ] `worker/src/rag/retriever.ts` — hybrid search:
  - Vector: `MATCH ?` against `chunk_vec` with embedded query
  - BM25: `chunks_fts MATCH ?` against tokenized query
  - Reciprocal-rank-fusion to combine top-50 from each
  - Optional: re-rank top-20 with a small cross-encoder (defer if no good local option)
- [ ] `worker/src/routes/rag.ts` — `/api/rag/index` (kicks reindex, streams progress), `/api/rag/search`, `/api/rag/status`

### SPA
- [ ] `@codebase` mention behaves like `@file`: opens a picker showing top retrieved chunks, lets user pick which to attach
- [ ] Index status panel: progress bar during reindex, last-indexed time, file count, total chunks
- [ ] "Re-index" button + ignore-pattern editor

### Fork contribution
- [ ] On workspace open, kick a background indexer if `.qbee/index.sqlite` is missing or stale
- [ ] Surface index status in the status bar

## Verification

1. Open a fresh workspace (~10k files): full index completes within ~5 min on local nomic-embed
2. Query `@codebase how is the worker spawned?` returns chunks from `workerManager.ts`
3. Edit a file → within ~2s, that file's chunks are re-indexed (verifiable by querying immediately and getting fresh content)
4. Delete a file → its chunks are removed
5. Hybrid retrieval: query "TODO" returns BM25 hits even for low-semantic-similarity strings
6. `.qbee/index.sqlite` size is reasonable (<100 MB for the test repo)

## Critical files (new)

- `worker/src/rag/store.ts`
- `worker/src/rag/chunker.ts`
- `worker/src/rag/indexer.ts`
- `worker/src/rag/retriever.ts`
- `worker/src/routes/rag.ts`
- `editor/src/vs/workbench/contrib/qbee/browser/ragStatusBar.ts`

## Gotchas

- **`sqlite-vec` is loaded as a SQLite extension** — `better-sqlite3` has `loadExtension` but it's locked down by default. Need `allowExtension: true`.
- **Embedding dimension** must match between indexer and retriever. Store dim in a meta table; refuse queries if model changed.
- **Tree-sitter native bindings** — be careful with prebuilt binaries; may need to rebuild for the Electron Node version (use `electron-rebuild` or `prebuildify`).
- **Watcher noise** — IDEs save files in many small writes. Debounce 500ms per file before re-indexing.
- **`.gitignore` parsing** — use the `ignore` npm package, not your own globber.
- **Incremental chunk diffing** — when a file changes, don't re-embed all chunks; diff old vs. new and only embed new/changed ones. AST-based chunking helps: a function whose body didn't change keeps its embedding.

## Next: [[Phase-6-AppImage-Release]]
