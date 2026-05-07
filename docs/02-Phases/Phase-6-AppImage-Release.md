# Phase 6 — AppImage release pipeline

**Goal:** `git tag v0.1.0 && git push --tags` produces a downloadable, signed, auto-updating AppImage on GitHub Releases.

**Demo at end:** download the AppImage on a clean machine, `chmod +x QBee.AppImage`, double-click, app launches. Future tag → user gets an in-app update prompt.

## Tasks

- [ ] `editor/build/electron-builder.yml` — extend VSCode's existing build config:
  - `target: AppImage` for `linux-x64` and `linux-arm64`
  - Custom `appId: io.github.<user>.qbee`
  - Icon, desktop entry, MIME associations
- [ ] GitHub Actions: `.github/workflows/release.yml`
  - Triggers on tag push `v*`
  - Matrix: `ubuntu-22.04` (x64), `ubuntu-22.04-arm` (arm64)
  - Builds editor, vendors SPA, packages AppImage
  - Signs with self-managed GPG key (secrets)
  - Creates GitHub Release with both AppImages + checksums + GPG signatures
- [ ] Auto-update wiring:
  - `electron-builder` AppImage updater pulls from GitHub releases atom feed
  - In-app: "Check for updates" command, "Download and restart" flow
- [ ] First release: `v0.1.0`

## Verification

1. Push tag, watch Actions workflow succeed end-to-end
2. Download AppImage to a clean Linux box (use a VM or a fresh user)
3. `chmod +x` and run — launches with QBee branding
4. Verify GPG signature: `gpg --verify QBee.AppImage.sig QBee.AppImage`
5. Tag `v0.1.1`, in the running v0.1.0 instance, "Check for updates" → prompts → downloads → restarts → now v0.1.1

## Critical files (new)

- `editor/build/electron-builder.yml` (or extend existing config)
- `.github/workflows/release.yml`
- `scripts/release.sh` — local dry-run release builder
- `editor/src/vs/workbench/contrib/qbee/browser/updater.ts` — UI for update flow

## Gotchas

- **AppImage size** — the editor + SPA + worker bundle is ~150-200 MB. Compressed AppImage helps but expect ~100 MB downloads. Document that.
- **`fuse2` requirement** — AppImage runtime needs `libfuse2` on the user's system. CachyOS has this. Ubuntu 22.04 needs `apt install libfuse2t64`. Document in README.
- **Native modules** — `better-sqlite3`, `sqlite-vec`, `tree-sitter` need to be rebuilt for the bundled Electron version. Use `electron-builder`'s `nodeGypRebuild: true`.
- **GPG key handling in CI** — store the private key as a GitHub secret, import into the runner, sign, then revoke from the runner. Never expose the key in logs.
- **Updater channel** — start with `stable` only. Add `beta` later if needed.

## After this: [[Phase-7-and-beyond]]

Embedded llama.cpp (`node-llama-cpp`), AUR PKGBUILD, Flatpak, MCP support.
