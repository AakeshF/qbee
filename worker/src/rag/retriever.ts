// Hybrid retrieval — vector top-50 + BM25 top-50 → reciprocal rank fusion → top-K.
// RRF is preferred over weighted-sum because the two scores are on incomparable scales
// (cosine similarity vs negated BM25), and tuning weights per-corpus is brittle.

import type { Provider } from '../providers/types.js'
import type { RagStore, SearchHit } from './store.js'

export type RetrieveOptions = {
  store: RagStore
  embeddingProvider: Provider
  query: string
  topK?: number
  candidatesPerSource?: number
  rrfK?: number
}

export async function retrieve(opts: RetrieveOptions): Promise<SearchHit[]> {
  const topK = opts.topK ?? 20
  const candidates = opts.candidatesPerSource ?? 50
  // RRF k smooths rank weighting; 60 is the canonical default from the paper.
  const k = opts.rrfK ?? 60

  let vectorHits: SearchHit[] = []
  let bm25Hits: SearchHit[] = []

  // Run both searches concurrently. Vector requires an embedding round-trip to the model;
  // BM25 is a pure SQL call. Don't let an embedding failure kill BM25 — log and degrade.
  const [vectorResult, bm25Result] = await Promise.allSettled([
    embedAndSearch(opts.embeddingProvider, opts.store, opts.query, candidates),
    Promise.resolve(opts.store.searchBM25(opts.query, candidates)),
  ])

  if (vectorResult.status === 'fulfilled') vectorHits = vectorResult.value
  if (bm25Result.status === 'fulfilled') bm25Hits = bm25Result.value

  return reciprocalRankFusion(vectorHits, bm25Hits, k, topK)
}

async function embedAndSearch(provider: Provider, store: RagStore, query: string, topK: number): Promise<SearchHit[]> {
  const result = await provider.embed([query])
  const embedding = result.vectors[0]
  if (!embedding) return []
  return store.searchVector(embedding, topK)
}

// Combine two ranked lists via reciprocal rank fusion: score = Σ 1/(k + rank).
// Tracks each chunk's best per-source score for downstream debugging.
function reciprocalRankFusion(a: SearchHit[], b: SearchHit[], k: number, topK: number): SearchHit[] {
  const merged = new Map<number, { hit: SearchHit; score: number }>()

  for (const list of [a, b]) {
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank]!
      const inc = 1 / (k + rank + 1)
      const existing = merged.get(hit.chunkId)
      if (existing) {
        existing.score += inc
      } else {
        merged.set(hit.chunkId, { hit, score: inc })
      }
    }
  }

  return Array.from(merged.values())
    .sort((x, y) => y.score - x.score)
    .slice(0, topK)
    .map(({ hit, score }) => ({ ...hit, score }))
}
