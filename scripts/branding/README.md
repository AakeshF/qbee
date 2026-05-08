# QBee branding assets

| File | Purpose |
|---|---|
| `qbee-1024.png` | Master icon, 1024×1024 PNG. Edit this and re-derive the others if you want to refresh the brand. |
| `qbee.ico` | Multi-size Windows icon (16/24/32/48/64/128/256). `scripts/build-windows.sh` swaps it into `editor/resources/win32/code.ico` before gulp so it gets embedded into the QBee.exe via rcedit. |
| `qbee.icns` | Multi-size macOS icon (16/32/64/128/256/512/1024 + retina sizes). `scripts/build-macos.sh` swaps it into `editor/resources/darwin/code.icns` before gulp so it lands in the .app bundle. |

The Linux AppImage icon lives at `scripts/appimage/qbee.png` (also a downscale of the master), which `scripts/build-appimage.sh` reads directly.

To regenerate from a new master:

```sh
# Linux AppImage icon (downscale)
magick scripts/branding/qbee-1024.png -resize 512x512 scripts/appimage/qbee.png

# Windows .ico (multi-size)
magick scripts/branding/qbee-1024.png \
  \( -clone 0 -resize 16x16 \) \( -clone 0 -resize 24x24 \) \
  \( -clone 0 -resize 32x32 \) \( -clone 0 -resize 48x48 \) \
  \( -clone 0 -resize 64x64 \) \( -clone 0 -resize 128x128 \) \
  \( -clone 0 -resize 256x256 \) \
  -delete 0 scripts/branding/qbee.ico

# macOS .icns — ImageMagick's .icns writer is unreliable; use Apple's
# iconutil if on macOS, or build the binary container directly.
# See scripts/build-icns.mjs in this dir for a portable Node builder.
```
