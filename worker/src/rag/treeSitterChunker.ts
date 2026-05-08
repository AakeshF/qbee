// Tree-sitter chunker. Parses source files into an AST and emits one chunk per
// top-level definition (function, class, method, struct, etc.) plus interleaved
// "preamble" chunks for the imports / top-level statements between them.
//
// Falls back to fixed-window chunking via the caller when:
//   - The language isn't supported here
//   - Tree-sitter init failed
//   - The file fails to parse
//
// Wasm files come from the `tree-sitter-wasms` package. In dev (tsx) they're
// loaded from node_modules; in the bundled worker, scripts/bundle-worker.sh
// copies them into a sibling `wasm/` directory.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// web-tree-sitter ~0.22 has a default-export Parser with Parser.Language as
// a static. Pinned to this major because tree-sitter-wasms@0.1.13 wasms are
// built with the older tree-sitter ABI and won't load with 0.25+.
import Parser from 'web-tree-sitter'
import type { RawChunk } from './chunker.js'

type Language = unknown // Parser.Language at runtime; we only pass it to setLanguage.

// Approximate target — we don't enforce a hard ceiling but oversized definitions
// get warned about for follow-up work (recursive splitting in v0.6).
const MAX_CHUNK_LINES = 200
const MIN_PREAMBLE_LINES = 1
const PREAMBLE_FLUSH_LINES = 80

// Per-language config: which AST node types are themselves a self-contained
// chunk. Anything that isn't on this list and sits at top level becomes part
// of the preamble.
type LangConfig = {
  wasm: string
  // Definition node types we treat as chunks.
  chunkNodeTypes: Set<string>
  // Wrapper types we descend into to find the real def — e.g. an
  // `export_statement` wrapping a function_declaration.
  wrapperNodeTypes?: Set<string>
}

const LANGS: Record<string, LangConfig> = {
  typescript: {
    wasm: 'tree-sitter-typescript.wasm',
    chunkNodeTypes: new Set([
      'function_declaration', 'class_declaration', 'method_definition',
      'interface_declaration', 'type_alias_declaration', 'enum_declaration',
      'function_signature', 'lexical_declaration', 'variable_declaration',
    ]),
    wrapperNodeTypes: new Set(['export_statement']),
  },
  tsx: {
    wasm: 'tree-sitter-tsx.wasm',
    chunkNodeTypes: new Set([
      'function_declaration', 'class_declaration', 'method_definition',
      'interface_declaration', 'type_alias_declaration', 'enum_declaration',
      'function_signature', 'lexical_declaration', 'variable_declaration',
    ]),
    wrapperNodeTypes: new Set(['export_statement']),
  },
  javascript: {
    wasm: 'tree-sitter-javascript.wasm',
    chunkNodeTypes: new Set([
      'function_declaration', 'class_declaration', 'method_definition',
      'lexical_declaration', 'variable_declaration',
    ]),
    wrapperNodeTypes: new Set(['export_statement']),
  },
  python: {
    wasm: 'tree-sitter-python.wasm',
    chunkNodeTypes: new Set(['function_definition', 'class_definition', 'decorated_definition']),
  },
  rust: {
    wasm: 'tree-sitter-rust.wasm',
    chunkNodeTypes: new Set([
      'function_item', 'impl_item', 'struct_item', 'enum_item',
      'trait_item', 'mod_item', 'macro_definition', 'type_item',
    ]),
  },
  go: {
    wasm: 'tree-sitter-go.wasm',
    chunkNodeTypes: new Set(['function_declaration', 'method_declaration', 'type_declaration']),
  },
  java: {
    wasm: 'tree-sitter-java.wasm',
    chunkNodeTypes: new Set([
      'class_declaration', 'interface_declaration', 'method_declaration',
      'constructor_declaration', 'enum_declaration',
    ]),
  },
  c: {
    wasm: 'tree-sitter-c.wasm',
    chunkNodeTypes: new Set(['function_definition', 'declaration', 'struct_specifier', 'enum_specifier']),
  },
  cpp: {
    wasm: 'tree-sitter-cpp.wasm',
    chunkNodeTypes: new Set([
      'function_definition', 'declaration', 'class_specifier',
      'struct_specifier', 'enum_specifier', 'namespace_definition',
    ]),
  },
}

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
}

let parserInitPromise: Promise<void> | null = null
const loadedLangs = new Map<string, Language>()
let wasmDir: string | null = null

function resolveWasmDir(): string {
  if (wasmDir !== null) return wasmDir
  // Bundled production: scripts/bundle-worker.sh drops wasms in <OUT>/wasm/
  // (sibling to server.cjs). Dev (tsx) reads from worker/node_modules/.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const bundled = path.join(here, 'wasm')
  const dev = path.join(here, '..', '..', 'node_modules', 'tree-sitter-wasms', 'out')
  try {
    require('node:fs').accessSync(path.join(bundled, 'tree-sitter-typescript.wasm'))
    wasmDir = bundled
  } catch {
    wasmDir = dev
  }
  return wasmDir
}

async function ensureParserInit(): Promise<void> {
  if (parserInitPromise) return parserInitPromise
  parserInitPromise = (async () => {
    // Pre-load the core wasm bytes and pass them directly. Avoids the
    // emscripten locateFile dance — which is shaky to reach from a deep
    // submodule of pnpm-isolated node_modules — by handing the runtime the
    // bytes so it doesn't have to fetch them itself.
    const here = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      // Bundled production: bundle-worker.sh copies wasms into <OUT>/wasm/.
      // After esbuild --format=cjs, `here` resolves to the dir containing
      // server.cjs (i.e. <OUT>).
      path.join(here, 'wasm', 'tree-sitter.wasm'),
      // Dev (tsx watch): from worker/src/rag/, climb to worker/node_modules/.
      path.join(here, '..', '..', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
    ]
    let wasmBinary: Buffer | null = null
    for (const c of candidates) {
      try { wasmBinary = await fs.readFile(c); break } catch { /* try next */ }
    }
    if (!wasmBinary) {
      throw new Error('tree-sitter core wasm not found')
    }
    await Parser.init({ wasmBinary })
  })()
  return parserInitPromise
}

async function loadLanguage(lang: string): Promise<Language | null> {
  if (loadedLangs.has(lang)) return loadedLangs.get(lang)!
  const cfg = LANGS[lang]
  if (!cfg) return null
  try {
    await ensureParserInit()
    const dir = resolveWasmDir()
    const wasmPath = path.join(dir, cfg.wasm)
    const language = await (Parser as unknown as { Language: { load(p: string): Promise<Language> } }).Language.load(wasmPath)
    loadedLangs.set(lang, language)
    return language
  } catch (err) {
    // One bad load shouldn't kill chunking forever; cache the failure as null
    // so the caller falls back to fixed-window.
    void err
    return null
  }
}

export function languageForExtension(ext: string): string | null {
  return EXT_TO_LANG[ext.toLowerCase()] ?? null
}

export function isTreeSitterSupported(ext: string): boolean {
  const lang = languageForExtension(ext)
  return lang !== null && lang in LANGS
}

export async function treeSitterChunk(content: string, ext: string): Promise<RawChunk[] | null> {
  const lang = languageForExtension(ext)
  if (!lang) return null
  const language = await loadLanguage(lang)
  if (!language) return null
  const cfg = LANGS[lang]!

  const parser = new Parser()
  parser.setLanguage(language as Parameters<Parser['setLanguage']>[0])
  let tree
  try {
    tree = parser.parse(content)
    if (!tree) return null
  } catch {
    return null
  }

  const lines = content.split('\n')
  const root = tree.rootNode
  const chunks: RawChunk[] = []

  // Walk top-level children. For each node:
  //   - If wrapper (export_statement) → unwrap to inner def
  //   - If chunk-eligible → flush preamble + emit as own chunk
  //   - Otherwise → accumulate into the preamble buffer
  let preambleStartLine: number | null = null
  let preambleEndLine: number | null = null
  const flushPreamble = () => {
    if (preambleStartLine === null || preambleEndLine === null) return
    const slice = lines.slice(preambleStartLine, preambleEndLine + 1)
    if (slice.join('').trim().length > 0 && slice.length >= MIN_PREAMBLE_LINES) {
      chunks.push({
        startLine: preambleStartLine + 1,
        endLine: preambleEndLine + 1,
        content: slice.join('\n'),
      })
    }
    preambleStartLine = null
    preambleEndLine = null
  }

  for (const child of root.namedChildren) {
    if (!child) continue
    let target = child
    if (cfg.wrapperNodeTypes?.has(child.type)) {
      // Look one level deep for the def. If the export wraps something
      // chunkable, unwrap; otherwise treat the whole export as preamble.
      const inner = child.namedChildren.find((c) => c && cfg.chunkNodeTypes.has(c.type))
      if (inner) target = inner
    }
    if (cfg.chunkNodeTypes.has(target.type)) {
      flushPreamble()
      const startLine = child.startPosition.row
      const endLine = child.endPosition.row
      const slice = lines.slice(startLine, endLine + 1)
      if (slice.length > MAX_CHUNK_LINES) {
        // Oversized def: keep as a single chunk. v0.6: recursive split into
        // method/body chunks. For now, prefer one big chunk over fragmenting
        // the def boundary.
      }
      if (slice.join('').trim().length === 0) continue
      chunks.push({
        startLine: startLine + 1,
        endLine: endLine + 1,
        content: slice.join('\n'),
      })
    } else {
      const start = child.startPosition.row
      const end = child.endPosition.row
      if (preambleStartLine === null) preambleStartLine = start
      preambleEndLine = end
      // Flush preamble if it gets too large.
      if (preambleEndLine - preambleStartLine + 1 >= PREAMBLE_FLUSH_LINES) {
        flushPreamble()
      }
    }
  }
  flushPreamble()

  return chunks
}
