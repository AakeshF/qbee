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
  x64)   GULP_ARCH=x64;   GO_ARCH=amd64 ;;
  arm64) GULP_ARCH=arm64; GO_ARCH=arm64 ;;
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

# Swap in the QBee Windows icon for gulp + rcedit to embed into QBee.exe.
# Save the upstream code.ico first so the working tree restores cleanly after.
ICON_SRC="$ROOT/scripts/branding/qbee.ico"
ICON_DEST="$ROOT/editor/resources/win32/code.ico"
ICON_BACKUP=""
if [ -f "$ICON_SRC" ]; then
  ICON_BACKUP="$(mktemp -t qbee-code-ico-backup-XXXXXX.ico)"
  cp "$ICON_DEST" "$ICON_BACKUP"
  cp "$ICON_SRC" "$ICON_DEST"
  trap 'cp "$ICON_BACKUP" "$ICON_DEST" 2>/dev/null; rm -f "$ICON_BACKUP"' EXIT
fi

# Pre-strip cross-platform binaries from the editor tree BEFORE gulp runs.
# rcedit.exe (upstream's metadata patcher) tries to load every .node/.exe/.dll
# in the output to set Windows version info — and chokes on Mach-O / non-host
# ELF binaries that ride along in extension-bundled prebuilds (notably
# @github/copilot/sdk/prebuilds and @anthropic-ai/claude-agent-sdk vendor).
# Same content-based strip we use post-gulp on Linux, but here it has to
# happen before package-win32 copies the node_modules into the output tree.
echo "    pre-stripping non-host binaries from editor tree"
HOST_PREBUILD_DIR="win32-${GULP_ARCH}"
find . -type d -name 'prebuilds' 2>/dev/null | while read -r dir; do
  for sub in "$dir"/*; do
    [ -d "$sub" ] || continue
    case "$(basename "$sub")" in
      "$HOST_PREBUILD_DIR") ;;
      *) rm -rf "$sub" ;;
    esac
  done
done
ELF_NEEDLE=""
case "$GULP_ARCH" in
  x64)   PE_ARCH="x86-64" ;;
  arm64) PE_ARCH="Aarch64" ;;
esac
find . -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -name '*.dylib' \) 2>/dev/null | while read -r f; do
  desc=$(file -b "$f" 2>/dev/null || true)
  case "$desc" in
    *"PE32+"*"$PE_ARCH"*) ;;       # keep host-arch Windows binaries
    *"Mach-O"*|*"ELF"*) rm -f "$f" ;;
    *) ;;
  esac
done

npm run gulp -- "vscode-win32-${GULP_ARCH}-min"

VSCODE_BUILD_DIR="$(cd "$ROOT/editor/.." && pwd)/VSCode-win32-${GULP_ARCH}"
if [ ! -d "$VSCODE_BUILD_DIR" ]; then
  echo "Expected $VSCODE_BUILD_DIR after gulp; not found" >&2
  exit 5
fi

echo "==> 4/5 assembling package"
PKGDIR="$ROOT/.build/QBee-${ARCH}-win"
rm -rf "$PKGDIR"
mkdir -p "$PKGDIR/app" "$PKGDIR/qbee-worker" "$PKGDIR/qbee-spa"
# Editor goes into app/ subdir so the launcher can sit at the package root
# under the same name (QBee.exe) without colliding on Windows's case-insensitive FS.
cp -a "$VSCODE_BUILD_DIR/." "$PKGDIR/app/"
cp -a "$ROOT/.build/worker/." "$PKGDIR/qbee-worker/"
cp -a "$ROOT/spa/dist/." "$PKGDIR/qbee-spa/"

# Sanity-check the editor binary made it into app/.
EDITOR_EXE=""
for cand in "QBee.exe" "qbee.exe" "Qbee.exe"; do
  if [ -f "$PKGDIR/app/$cand" ]; then EDITOR_EXE="$cand"; break; fi
done
if [ -z "$EDITOR_EXE" ]; then
  echo "Could not locate editor .exe in $PKGDIR/app" >&2
  ls "$PKGDIR/app" | head -20 >&2
  exit 6
fi
echo "  editor binary: app/$EDITOR_EXE"

echo "==> 5/5 building Go launcher → QBee.exe"
# Cross-compile the Go launcher. windows-latest has Go preinstalled; Linux
# cross-compiles via GOOS=windows GOARCH=amd64. Both produce the same binary.
( cd "$ROOT/scripts/launcher" && \
  GOOS=windows GOARCH="$GO_ARCH" go build -ldflags='-s -w -H=windowsgui' -o "$PKGDIR/QBee.exe" ./... )
# -H=windowsgui prevents a console window from flashing when the user double-clicks.
# Sanity check the output.
file "$PKGDIR/QBee.exe" | head -1

echo "==> packaging zip"
mkdir -p "$ROOT/.build/dist"
OUT="$ROOT/.build/dist/QBee-${VERSION}-${ARCH}-win.zip"
# Multiple paths in priority order — different runners have different tools.
if command -v zip >/dev/null 2>&1; then
  ( cd "$PKGDIR/.." && zip -qr "$OUT" "QBee-${ARCH}-win" )
elif command -v 7z >/dev/null 2>&1; then
  7z a -tzip "$OUT" "$PKGDIR" >/dev/null
else
  for py in python3 python py; do
    if command -v $py >/dev/null 2>&1; then
      $py -c "import shutil; shutil.make_archive('$ROOT/.build/dist/QBee-${VERSION}-${ARCH}-win', 'zip', '$ROOT/.build', 'QBee-${ARCH}-win')"
      break
    fi
  done
fi
[ -f "$OUT" ] || { echo "Failed to create $OUT" >&2; exit 7; }
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUT" > "${OUT}.sha256"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$OUT" > "${OUT}.sha256"
else
  certutil -hashfile "$OUT" SHA256 | head -2 | tail -1 | tr -d '\r' | awk -v p="$OUT" '{print $1 "  " p}' > "${OUT}.sha256"
fi

echo
echo "✓ $OUT"
du -h "$OUT" | cut -f1
ls -la "${OUT}.sha256"
