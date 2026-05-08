#!/usr/bin/env bash
# build-appimage.sh — package the QBee fork as a Linux AppImage.
#
# Pipeline:
#   1. pnpm -w build           build SPA + worker + vendor SPA into editor's spa-dist/
#   2. gulp vscode-linux-${ARCH}-min   produce VSCode-linux-${ARCH}/ tree (heavy: 15-30 min first run)
#   3. assemble AppDir         copy that tree + AppRun + .desktop + icon
#   4. appimagetool            squash AppDir into a single QBee-${ARCH}.AppImage
#
# Phase 6 limitations documented in docs/02-Phases/Phase-6-AppImage-Release.md:
#   - No GPG signing yet
#   - No in-app updater yet
#   - The worker is NOT bundled — AI features need spaProxyService + workerManager (Phase 6.5)
#     to ship a self-contained binary. Today's AppImage is editor-only.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${ARCH:-x64}"          # x64 | arm64
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo 0.0.0)}"
APPIMAGETOOL="${APPIMAGETOOL:-appimagetool}"
NODE22_BIN="${HOME}/.local/opt/node-22/bin"

case "$ARCH" in
  x64)   GULP_ARCH=x64;   APPIMAGE_ARCH=x86_64 ;;
  arm64) GULP_ARCH=arm64; APPIMAGE_ARCH=aarch64 ;;
  *)     echo "Unsupported ARCH=$ARCH (expected x64 or arm64)" >&2; exit 2 ;;
esac

# Need Node 22 on PATH — VSCode upstream pins it via .nvmrc.
if [ -d "$NODE22_BIN" ]; then
  export PATH="$NODE22_BIN:$PATH"
fi

if ! command -v "$APPIMAGETOOL" >/dev/null 2>&1; then
  cat <<EOF >&2
appimagetool not found. Install it once:
  curl -fsSL "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${APPIMAGE_ARCH}.AppImage" -o ~/.local/bin/appimagetool
  chmod +x ~/.local/bin/appimagetool
or set APPIMAGETOOL=/path/to/appimagetool.
EOF
  exit 3
fi

# An icon is required by the AppImage spec. Phase 0 deferred this — fail clearly with how to fix.
ICON_SOURCE="$ROOT/scripts/appimage/qbee.png"
if [ ! -f "$ICON_SOURCE" ]; then
  cat <<EOF >&2
Missing $ICON_SOURCE — Phase 0 deferred icon design.

Drop a 256x256 (or larger square) PNG at scripts/appimage/qbee.png and re-run.
For a placeholder you can ship today:
  convert -size 512x512 xc:'#3a6cd8' -gravity center -fill white -pointsize 320 -annotate +0+0 'Q' scripts/appimage/qbee.png
EOF
  exit 4
fi

echo "==> 1/5 building SPA + worker + vendoring SPA"
cd "$ROOT"
pnpm -w build

echo "==> 2/5 bundling worker (esbuild → single .cjs + native deps)"
bash "$ROOT/scripts/bundle-worker.sh"

echo "==> 3/5 building editor (gulp vscode-linux-${GULP_ARCH}-min) — this is the long step"
cd "$ROOT/editor"
if [ ! -d node_modules ]; then
  npm install --legacy-peer-deps
fi
npm run gulp -- "vscode-linux-${GULP_ARCH}-min"

VSCODE_BUILD_DIR="$(cd "$ROOT/editor/.." && pwd)/VSCode-linux-${GULP_ARCH}"
if [ ! -d "$VSCODE_BUILD_DIR" ]; then
  echo "Expected $VSCODE_BUILD_DIR after gulp; not found" >&2
  exit 5
fi

echo "==> 4/5 assembling AppDir"
APPDIR="$ROOT/.build/QBee-${ARCH}.AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR"
cp -a "$VSCODE_BUILD_DIR/." "$APPDIR/"
install -m 0755 "$ROOT/scripts/appimage/AppRun" "$APPDIR/AppRun"
install -m 0644 "$ROOT/scripts/appimage/qbee.desktop" "$APPDIR/qbee.desktop"
install -m 0644 "$ICON_SOURCE" "$APPDIR/qbee.png"
# AppImage spec also wants a top-level .DirIcon (a copy/link of the icon).
cp "$APPDIR/qbee.png" "$APPDIR/.DirIcon"
# Worker bundle (server.cjs + native node_modules) and SPA build.
mkdir -p "$APPDIR/qbee-worker" "$APPDIR/qbee-spa"
cp -a "$ROOT/.build/worker/." "$APPDIR/qbee-worker/"
cp -a "$ROOT/spa/dist/." "$APPDIR/qbee-spa/"

echo "==> 5/5 packaging AppImage"
mkdir -p "$ROOT/.build/dist"
OUT="$ROOT/.build/dist/QBee-${VERSION}-${APPIMAGE_ARCH}.AppImage"

# Many bundled npm modules (better-sqlite3, @github/copilot/sdk, etc.) ship
# pre-built binaries for every supported (os, arch) combo under prebuilds/.
# On a host where we compile from source — and on Linux runners that don't
# need the darwin/win32 binaries at all — those prebuilds are dead weight,
# AND they trip appimagetool's auto-architecture detection
# ("more than one architectures were found"). Strip everything except the
# matching linux-<host> entry across the whole AppDir.
echo "==> stripping non-host prebuilds from AppDir"
case "$APPIMAGE_ARCH" in
  x86_64)  HOST_PREBUILD_DIR="linux-x64" ;;
  aarch64) HOST_PREBUILD_DIR="linux-arm64" ;;
esac
find "$APPDIR" -type d -name 'prebuilds' 2>/dev/null | while read -r dir; do
  for sub in "$dir"/*; do
    [ -d "$sub" ] || continue
    case "$(basename "$sub")" in
      "$HOST_PREBUILD_DIR") ;;
      *) rm -rf "$sub" ;;
    esac
  done
done

# Walk EVERY binary file (.node, .so, .dylib, .dll) and delete anything that
# isn't an ELF binary for the host arch. Bundled extensions (sharp, the
# Anthropic SDK's audio-capture vendor dir, ms-vscode.js-debug) ship native
# binaries for multiple OS/arch combos outside conventional `prebuilds/`
# directories; appimagetool's auto-detect refuses to package multi-arch trees.
echo "==> stripping non-host native binaries"
case "$APPIMAGE_ARCH" in
  x86_64)  ELF_NEEDLE="x86-64" ;;
  aarch64) ELF_NEEDLE="ARM aarch64" ;;
esac
deleted=0
find "$APPDIR" -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -name '*.dylib' -o -name '*.dll' \) 2>/dev/null | while read -r f; do
  desc=$(file -b "$f" 2>/dev/null)
  case "$desc" in
    *"ELF"*"$ELF_NEEDLE"*) ;;  # keep
    *)
      rm -f "$f"
      printf '  rm %s :: %s\n' "$f" "$(printf '%s' "$desc" | head -c 60)"
      ;;
  esac
done
# Second pass: scan EVERY regular file in the AppDir (not just by extension)
# and delete anything `file` identifies as a non-host binary. appimagetool
# auto-detects arch by content, so extensionless executables (e.g.
# bundled language-server binaries) still trip it.
echo "==> stripping non-host binaries by content (slow but thorough)"
find "$APPDIR" -type f -size +1c 2>/dev/null | xargs -r file 2>/dev/null | while IFS=: read -r path desc; do
  case "$desc" in
    *"ELF"*"$ELF_NEEDLE"*) ;;                              # keep host ELF
    *"ELF"*) rm -f "$path"; printf '  rm[ELF-other] %s\n' "$path" ;;
    *"Mach-O"*) rm -f "$path"; printf '  rm[mach-o]   %s\n' "$path" ;;
    *"PE32"*) rm -f "$path"; printf '  rm[PE32]      %s\n' "$path" ;;
  esac
done

echo "==> final survivor scan"
foreign_count=0
find "$APPDIR" -type f -size +1c 2>/dev/null | xargs -r file 2>/dev/null | while IFS=: read -r path desc; do
  case "$desc" in
    *"ELF"*"$ELF_NEEDLE"*) ;;
    *"ELF"*|*"Mach-O"*|*"PE32"*)
      printf '  STILL FOREIGN: %s :: %s\n' "$path" "$(printf '%s' "$desc" | head -c 60)"
      ;;
  esac
done

# appimagetool reads ARCH from its environment to label the output. Without an
# explicit export it walks the AppDir and refuses if it sees mixed architectures
# (which happens when the bundled worker's better-sqlite3 prebuilds + the editor's
# native modules don't all match — observed on arm64). Force it via export.
export ARCH="$APPIMAGE_ARCH"
"$APPIMAGETOOL" --no-appstream "$APPDIR" "$OUT"

# Checksum so users can verify even without GPG. Run from the file's dir so
# the sidecar records the basename rather than an absolute CI-runner path —
# otherwise `sha256sum -c` fails on the user's machine looking for a path
# that only exists in the build env.
( cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )

echo
echo "✓ $OUT"
echo "  $(du -h "$OUT" | cut -f1)"
ls -la "${OUT}.sha256"
