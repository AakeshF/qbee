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

# Smoke-test the bundle parses. (Doesn't run it — that needs the env.)
node --check "$OUT/server.cjs"

ls -lh "$OUT/server.cjs"
echo "✓ worker bundled at $OUT/server.cjs"
