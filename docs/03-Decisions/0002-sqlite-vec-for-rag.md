# ADR 0002 — `sqlite-vec` for RAG storage

**Date:** 2026-05-06
**Status:** Accepted

## Context

`@codebase` RAG needs a vector store. Constraints: must ship inside an AppImage, must work fully offline, must handle 10k-file repos snappily, low ops burden.

## Options considered

1. **`sqlite-vec`** — SQLite extension, single-file DB *(chosen)*
2. **LanceDB** — embedded columnar vector DB, Rust core. Better for multi-million-chunk monorepos.
3. **Qdrant embedded** — production vector DB. Overkill; daemon to manage.
4. **In-memory + flat search** — simplest; doesn't survive restart; doesn't scale past ~10k chunks.

## Decision

`better-sqlite3` + `sqlite-vec` extension, one DB file per workspace at `.qbee/index.sqlite`.

## Why

- Single-file DB matches "open a workspace, things just work" UX
- ~1 MB binary footprint
- SQLite handles concurrency, durability, FTS5 (BM25 for hybrid retrieval) in the same file
- No daemon = no port conflicts, no startup orchestration
- Repo-scale (≤ a few million chunks) is firmly in sqlite-vec's wheelhouse

## Trade-offs

- For users with monorepos > a few million chunks, performance degrades. Document the limit; provide an escape hatch (LanceDB backend) later if anyone hits it.
- `loadExtension` requires `allowExtension: true` on `better-sqlite3`. Mild ceremony.
- Tree-sitter native bindings need rebuilding for the bundled Electron version (use `electron-rebuild` in CI).

## Consequences

The RAG layer commits to sqlite + sqlite-vec semantics. If we ever need a different store, the abstraction boundary is `worker/src/rag/store.ts`'s public functions: `upsert`, `search`, `delete`. Replace the implementation, leave the interface.
