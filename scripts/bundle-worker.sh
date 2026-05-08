#!/usr/bin/env bash
# bundle-worker.sh — esbuild the worker into a single .js with native deps as externals.
#
# Output layout (drop into AppDir for shipping):
#   .build/worker/server.cjs          — single-file worker bundle (CommonJS)
#   .build/worker/node_modules/       — only the native deps (better-sqlite3, sqlite-vec)
#                                       since they ship .node binaries that esbuild can't inline

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.build/worker"
NODE_VERSION="${NODE_VERSION:-22.22.1}"
TARGET_OS="${TARGET_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"  # linux | darwin | win
TARGET_ARCH_HOST="$(uname -m)"
case "${TARGET_ARCH:-$TARGET_ARCH_HOST}" in
  x86_64|x64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) NODE_ARCH="${TARGET_ARCH:-$TARGET_ARCH_HOST}" ;;
esac

cd "$ROOT/worker"

echo "==> esbuild bundle"
rm -rf "$OUT"
mkdir -p "$OUT"

# Native deps need to stay external — they include .node binaries esbuild can't process.
# Everything else gets inlined.
node_modules/.bin/esbuild src/server.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="$OUT/server.cjs" \
  --external:better-sqlite3 \
  --external:sqlite-vec \
  --external:sqlite-vec-linux-x64 \
  --external:sqlite-vec-linux-arm64 \
  --external:sqlite-vec-darwin-x64 \
  --external:sqlite-vec-darwin-arm64 \
  --external:bufferutil \
  --external:utf-8-validate

echo "==> copying native deps"
mkdir -p "$OUT/node_modules"
# Use realpath because pnpm symlinks deps into a virtual store; we need the real .node files.
copy_dep() {
  local name=$1
  # Resolve via the package's main entry, then walk up to its package.json.
  # We can't use `require.resolve('$name/package.json')` because some packages
  # (e.g. sqlite-vec) restrict subpath access via package.json exports.
  local src
  src=$(node -e "
    const path = require('path');
    const fs = require('fs');
    let dir = path.dirname(require.resolve('$name'));
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pkg.name === '$name') { console.log(dir); break; }
      }
      dir = path.dirname(dir);
    }
  " 2>/dev/null || true)
  if [ -z "$src" ] || [ ! -d "$src" ]; then
    echo "WARN: dep '$name' not found, skipping" >&2
    return
  fi
  local dest="$OUT/node_modules/$name"
  mkdir -p "$(dirname "$dest")"
  # Dereference pnpm symlinks: copy the actual package contents.
  rm -rf "$dest"
  cp -RL "$src" "$dest"
}

copy_dep better-sqlite3
copy_dep sqlite-vec

# sqlite-vec ships per-platform packages as optionalDependencies — copy whichever ones got installed.
for platform_pkg in sqlite-vec-linux-x64 sqlite-vec-linux-arm64 sqlite-vec-darwin-x64 sqlite-vec-darwin-arm64; do
  copy_dep "$platform_pkg" 2>/dev/null || true
done

# Tree-sitter wasms — copy the core runtime + the language wasms the chunker
# might load. The chunker (worker/src/rag/treeSitterChunker.ts) reads from
# $OUT/wasm/ at runtime in the bundled config.
echo "==> copying tree-sitter wasms"
mkdir -p "$OUT/wasm"
cp node_modules/web-tree-sitter/tree-sitter.wasm "$OUT/wasm/tree-sitter.wasm"
for lang in typescript tsx javascript python rust go java c cpp; do
  cp "node_modules/tree-sitter-wasms/out/tree-sitter-${lang}.wasm" "$OUT/wasm/tree-sitter-${lang}.wasm"
done
ls -1 "$OUT/wasm/" | wc -l | xargs -I {} echo "  {} wasms copied"

# Smoke-test the bundle parses. (Doesn't run it — that needs the env.)
node --check "$OUT/server.cjs"

# Bundle a Node runtime so the AppImage / Windows zip don't depend on the
# user's system Node. Skipped when SKIP_NODE_BUNDLE=1 (e.g. local dev runs).
if [ "${SKIP_NODE_BUNDLE:-0}" != "1" ]; then
  echo "==> bundling node ${NODE_VERSION} for ${TARGET_OS}-${NODE_ARCH}"
  case "$TARGET_OS" in
    linux)
      url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
      curl -fsSL "$url" -o "$OUT/node.tar.xz"
      tar -xf "$OUT/node.tar.xz" -C "$OUT"
      mv "$OUT/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/node" "$OUT/node"
      rm -rf "$OUT/node-v${NODE_VERSION}-linux-${NODE_ARCH}" "$OUT/node.tar.xz"
      chmod +x "$OUT/node"
      ;;
    win|windows|cygwin*|mingw*|msys*)
      url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-${NODE_ARCH}.zip"
      curl -fsSL "$url" -o "$OUT/node.zip"
      ( cd "$OUT" && unzip -q node.zip )
      mv "$OUT/node-v${NODE_VERSION}-win-${NODE_ARCH}/node.exe" "$OUT/node.exe"
      rm -rf "$OUT/node-v${NODE_VERSION}-win-${NODE_ARCH}" "$OUT/node.zip"
      ;;
    darwin)
      url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
      curl -fsSL "$url" -o "$OUT/node.tar.gz"
      tar -xf "$OUT/node.tar.gz" -C "$OUT"
      mv "$OUT/node-v${NODE_VERSION}-darwin-${NODE_ARCH}/bin/node" "$OUT/node"
      rm -rf "$OUT/node-v${NODE_VERSION}-darwin-${NODE_ARCH}" "$OUT/node.tar.gz"
      chmod +x "$OUT/node"
      ;;
  esac
fi

ls -lh "$OUT/server.cjs" "$OUT"/node* 2>/dev/null
echo "✓ worker bundle at $OUT (target: ${TARGET_OS}-${NODE_ARCH})"
