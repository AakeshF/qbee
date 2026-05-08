#!/usr/bin/env bash
# build-macos.sh — package the QBee fork as a macOS .app + .dmg.
#
# Pipeline:
#   1. pnpm -w build                          SPA + worker + vendor SPA
#   2. bundle-worker.sh (TARGET_OS=darwin)    bundle worker → server.cjs + node
#   3. pre-strip cross-platform binaries      (same lesson as Windows; rcedit-style
#                                              tools / signing tools choke on them)
#   4. gulp vscode-darwin-${ARCH}-min         produce VSCode-darwin-${ARCH}/QBee.app
#   5. swap launcher into the .app bundle    Contents/MacOS/QBee → our Go binary
#                                              with the original moved to QBee-editor
#   6. drop in worker + spa under Resources/
#   7. zip + dmg                              .build/dist/QBee-${VERSION}-${ARCH}-mac.{zip,dmg}
#
# Code signing is NOT done. macOS Gatekeeper will warn about an unsigned app;
# users have to right-click → Open the first time. v0.4 carries the GPG-signing-
# alike work; signed macOS releases need an Apple Developer account.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${ARCH:-x64}"
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo 0.0.0)}"

case "$ARCH" in
  x64)   GULP_ARCH=x64;   MACH_ARCH="x86_64";   GO_ARCH=amd64 ;;
  arm64) GULP_ARCH=arm64; MACH_ARCH="arm64";    GO_ARCH=arm64 ;;
  *)     echo "Unsupported ARCH=$ARCH (expected x64 or arm64)" >&2; exit 2 ;;
esac

echo "==> 1/7 building SPA + worker + vendoring SPA"
cd "$ROOT"
pnpm -w build

echo "==> 2/7 bundling worker for darwin-${ARCH}"
TARGET_OS=darwin TARGET_ARCH="$ARCH" bash "$ROOT/scripts/bundle-worker.sh"

echo "==> 3/7 building editor (gulp vscode-darwin-${GULP_ARCH}-min)"
cd "$ROOT/editor"
if [ ! -d node_modules ]; then
  npm install --legacy-peer-deps
fi

# Swap in the QBee macOS icon so gulp picks it up when staging the .app bundle.
# Save the upstream code.icns so the working tree restores cleanly after.
ICON_SRC="$ROOT/scripts/branding/qbee.icns"
ICON_DEST="$ROOT/editor/resources/darwin/code.icns"
ICON_BACKUP=""
if [ -f "$ICON_SRC" ]; then
  ICON_BACKUP="$(mktemp -t qbee-code-icns-backup-XXXXXX.icns)"
  cp "$ICON_DEST" "$ICON_BACKUP"
  cp "$ICON_SRC" "$ICON_DEST"
  trap 'cp "$ICON_BACKUP" "$ICON_DEST" 2>/dev/null; rm -f "$ICON_BACKUP"' EXIT
fi

# Pre-strip cross-platform binaries from the editor tree before gulp runs.
# Same logic as build-windows.sh.
echo "    pre-stripping non-host binaries from editor tree"
HOST_PREBUILD_DIR="darwin-${GULP_ARCH}"
find . -type d -name 'prebuilds' 2>/dev/null | while read -r dir; do
  for sub in "$dir"/*; do
    [ -d "$sub" ] || continue
    case "$(basename "$sub")" in
      "$HOST_PREBUILD_DIR") ;;
      *) rm -rf "$sub" ;;
    esac
  done
done
find . -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -name '*.dylib' \) 2>/dev/null | while read -r f; do
  desc=$(file -b "$f" 2>/dev/null || true)
  case "$desc" in
    *"Mach-O"*"$MACH_ARCH"*) ;;       # keep host-arch Mach-O
    *"Mach-O universal"*) ;;          # keep universal binaries
    *"PE32"*|*"ELF"*) rm -f "$f" ;;
    *) ;;
  esac
done

npm run gulp -- "vscode-darwin-${GULP_ARCH}-min"

VSCODE_BUILD_DIR="$(cd "$ROOT/editor/.." && pwd)/VSCode-darwin-${GULP_ARCH}"
APP_NAME=""
for cand in "QBee.app" "Code - OSS.app"; do
  if [ -d "$VSCODE_BUILD_DIR/$cand" ]; then APP_NAME="$cand"; break; fi
done
if [ -z "$APP_NAME" ]; then
  echo "Could not locate .app bundle in $VSCODE_BUILD_DIR" >&2
  ls "$VSCODE_BUILD_DIR" >&2
  exit 5
fi
echo "  app bundle: $APP_NAME"

echo "==> 4/7 staging .app for our launcher"
PKGDIR="$ROOT/.build/QBee-${ARCH}-mac"
rm -rf "$PKGDIR"
mkdir -p "$PKGDIR"
cp -a "$VSCODE_BUILD_DIR/$APP_NAME" "$PKGDIR/QBee.app"

# Find the main editor executable inside Contents/MacOS/.
MACOS_DIR="$PKGDIR/QBee.app/Contents/MacOS"
EDITOR_EXE_NAME=""
for cand in "QBee" "Electron" "Code - OSS"; do
  if [ -f "$MACOS_DIR/$cand" ]; then EDITOR_EXE_NAME="$cand"; break; fi
done
if [ -z "$EDITOR_EXE_NAME" ]; then
  echo "Could not locate editor binary in $MACOS_DIR" >&2
  ls "$MACOS_DIR" >&2
  exit 6
fi
echo "  editor binary: Contents/MacOS/$EDITOR_EXE_NAME"

# Stash the original editor under a different name so the launcher can find it
# via the resolveLayout fallback (Electron / QBee / QBee Helper / Code).
# Then drop the launcher in as the canonical CFBundleExecutable target.
echo "==> 5/7 building Go launcher → Contents/MacOS/qbee-launcher"
( cd "$ROOT/scripts/launcher" && \
  GOOS=darwin GOARCH="$GO_ARCH" go build -ldflags='-s -w' -o "$MACOS_DIR/qbee-launcher" ./... )
chmod +x "$MACOS_DIR/qbee-launcher"
file "$MACOS_DIR/qbee-launcher" | head -1

# Update Info.plist's CFBundleExecutable to point at our launcher.
INFO_PLIST="$PKGDIR/QBee.app/Contents/Info.plist"
if command -v plutil >/dev/null 2>&1; then
  plutil -replace CFBundleExecutable -string "qbee-launcher" "$INFO_PLIST"
else
  # plutil is macOS-only; on Linux cross-builds use sed on the XML form. We
  # ensure XML format first via xmllint or just trust gulp's output (XML).
  python3 - "$INFO_PLIST" <<'PY'
import plistlib, sys
path = sys.argv[1]
with open(path, 'rb') as f:
    data = plistlib.load(f)
data['CFBundleExecutable'] = 'qbee-launcher'
with open(path, 'wb') as f:
    plistlib.dump(data, f)
PY
fi

echo "==> 6/7 dropping worker + SPA into Contents/Resources/"
RES="$PKGDIR/QBee.app/Contents/Resources"
mkdir -p "$RES/qbee-worker" "$RES/qbee-spa"
cp -a "$ROOT/.build/worker/." "$RES/qbee-worker/"
cp -a "$ROOT/spa/dist/." "$RES/qbee-spa/"

echo "==> 7/7 packaging zip + dmg"
mkdir -p "$ROOT/.build/dist"
ZIP_OUT="$ROOT/.build/dist/QBee-${VERSION}-${ARCH}-mac.zip"
( cd "$PKGDIR" && \
  if command -v ditto >/dev/null 2>&1; then
    ditto -c -k --keepParent --sequesterRsrc "QBee.app" "$ZIP_OUT"
  elif command -v zip >/dev/null 2>&1; then
    zip -qr "$ZIP_OUT" "QBee.app"
  else
    python3 -c "import shutil; shutil.make_archive('${ZIP_OUT%.zip}', 'zip', '$PKGDIR', 'QBee.app')"
  fi
)

# DMG: hdiutil sometimes races with Spotlight indexing the freshly-written
# .app and reports "Resource busy". Retry a few times; fall back to zip-only
# if it keeps failing. We always ship the zip too — .dmg is just nicer UX
# (drag-to-Applications window).
DMG_OUT=""
if command -v hdiutil >/dev/null 2>&1; then
  DMG_OUT="$ROOT/.build/dist/QBee-${VERSION}-${ARCH}-mac.dmg"
  rm -f "$DMG_OUT"
  attempt=0
  until [ "$attempt" -ge 4 ]; do
    if hdiutil create -volname "QBee ${VERSION}" -srcfolder "$PKGDIR/QBee.app" -ov -format UDZO "$DMG_OUT" 2>&1; then
      break
    fi
    attempt=$((attempt + 1))
    echo "    hdiutil attempt $attempt failed; sleeping 10s and retrying" >&2
    rm -f "$DMG_OUT"
    sleep 10
  done
  if [ ! -f "$DMG_OUT" ]; then
    echo "::warning::hdiutil failed after 4 attempts; shipping .zip only for ${ARCH}-mac" >&2
    DMG_OUT=""
  fi
fi

# Checksums
for f in "$ZIP_OUT" "$DMG_OUT"; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" > "${f}.sha256"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" > "${f}.sha256"
  fi
done

echo
echo "✓ $ZIP_OUT"
[ -n "$DMG_OUT" ] && [ -f "$DMG_OUT" ] && echo "✓ $DMG_OUT"
ls -la "$ROOT/.build/dist/" | grep "${VERSION}-${ARCH}-mac"
