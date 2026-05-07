#!/usr/bin/env bash
# build-windows.sh — package the QBee fork as a Windows portable zip.
#
# Pipeline:
#   1. pnpm -w build                       SPA + worker + vendor SPA into editor's spa-dist/
#   2. bundle-worker.sh (TARGET_OS=win)    bundle worker → server.cjs + node.exe
#   3. gulp vscode-win32-${ARCH}-min       produce VSCode-win32-${ARCH}/ tree
#   4. assemble package                    .build/QBee-${ARCH}-win/ with qbee.cmd launcher
#   5. zip                                 .build/dist/QBee-${VERSION}-${ARCH}-win.zip
#
# Runs on either Linux (cross-build via npm install on the editor for win32)
# or natively on a Windows runner with Git Bash. Native Windows is the
# supported path; cross-build is best-effort.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${ARCH:-x64}"
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo 0.0.0)}"

case "$ARCH" in
  x64)   GULP_ARCH=x64 ;;
  arm64) GULP_ARCH=arm64 ;;
  *)     echo "Unsupported ARCH=$ARCH" >&2; exit 2 ;;
esac

echo "==> 1/4 building SPA + worker + vendoring SPA"
cd "$ROOT"
pnpm -w build

echo "==> 2/4 bundling worker for win-${ARCH}"
TARGET_OS=win TARGET_ARCH="$ARCH" bash "$ROOT/scripts/bundle-worker.sh"

echo "==> 3/4 building editor (gulp vscode-win32-${GULP_ARCH}-min)"
cd "$ROOT/editor"
if [ ! -d node_modules ]; then
  npm install --legacy-peer-deps
fi
npm run gulp -- "vscode-win32-${GULP_ARCH}-min"

VSCODE_BUILD_DIR="$(cd "$ROOT/editor/.." && pwd)/VSCode-win32-${GULP_ARCH}"
if [ ! -d "$VSCODE_BUILD_DIR" ]; then
  echo "Expected $VSCODE_BUILD_DIR after gulp; not found" >&2
  exit 5
fi

echo "==> 4/4 assembling package"
PKGDIR="$ROOT/.build/QBee-${ARCH}-win"
rm -rf "$PKGDIR"
mkdir -p "$PKGDIR"
cp -a "$VSCODE_BUILD_DIR/." "$PKGDIR/"
mkdir -p "$PKGDIR/qbee-worker" "$PKGDIR/qbee-spa"
cp -a "$ROOT/.build/worker/." "$PKGDIR/qbee-worker/"
cp -a "$ROOT/spa/dist/." "$PKGDIR/qbee-spa/"

# Find the editor exe — VSCode uses nameShort. We branded as "QBee".
EDITOR_EXE=""
for cand in "QBee.exe" "qbee.exe" "Qbee.exe"; do
  if [ -f "$PKGDIR/$cand" ]; then EDITOR_EXE="$cand"; break; fi
done
if [ -z "$EDITOR_EXE" ]; then
  echo "Could not locate editor .exe in $PKGDIR" >&2
  ls "$PKGDIR" | head -20 >&2
  exit 6
fi
echo "  editor binary: $EDITOR_EXE"

# Launcher .cmd. Starts the bundled worker on a fixed port (18421) and a
# pseudo-random auth token, then launches the editor with QBEE_WORKER_URL set.
# Limitations vs the Linux AppRun: no free-port detection (Windows cmd doesn't
# have a clean way to ask the kernel for one without PowerShell), no ready
# handshake wait. Acceptable for v0.3 first cut.
cat > "$PKGDIR/qbee.cmd" <<EOF
@echo off
setlocal
set "HERE=%~dp0"
set QBEE_WORKER_PORT=18421
set /a "QBEE_RAND=%RANDOM%%RANDOM%"
set "QBEE_WORKER_AUTH=qbee%QBEE_RAND%"
set "QBEE_SPA_DIST=%HERE%qbee-spa"
set "QBEE_WORKER_URL=http://127.0.0.1:%QBEE_WORKER_PORT%"
if exist "%HERE%qbee-worker\\node.exe" (
  start "" /b "%HERE%qbee-worker\\node.exe" "%HERE%qbee-worker\\server.cjs" 1>nul 2>nul
)
"%HERE%${EDITOR_EXE}" %*
EOF

echo "==> packaging zip"
mkdir -p "$ROOT/.build/dist"
OUT="$ROOT/.build/dist/QBee-${VERSION}-${ARCH}-win.zip"
( cd "$PKGDIR/.." && python3 -c "
import shutil
shutil.make_archive('$ROOT/.build/dist/QBee-${VERSION}-${ARCH}-win', 'zip', '$ROOT/.build', 'QBee-${ARCH}-win')
" )
sha256sum "$OUT" > "${OUT}.sha256" || shasum -a 256 "$OUT" > "${OUT}.sha256"

echo
echo "✓ $OUT"
du -h "$OUT" | cut -f1
ls -la "${OUT}.sha256"
