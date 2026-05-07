#!/usr/bin/env bash
# vendor-spa.sh — copy spa/dist/* into the editor fork's spa-dist/ directory.
# Called by `pnpm -w build` and the /rebuild-spa slash command.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$PROJECT_DIR/spa/dist"
DST="$PROJECT_DIR/editor/src/vs/workbench/contrib/qbee/spa-dist"

if [ ! -d "$SRC" ]; then
  echo "error: $SRC does not exist. Run 'pnpm --filter @qbee/spa build' first."
  exit 1
fi

if [ ! -d "$PROJECT_DIR/editor" ]; then
  echo "warning: editor/ not present yet (run ./scripts/init-fork.sh). Skipping vendoring."
  exit 0
fi

mkdir -p "$DST"
rm -rf "$DST"/*
cp -r "$SRC"/* "$DST"/
echo "Vendored $SRC → $DST"
