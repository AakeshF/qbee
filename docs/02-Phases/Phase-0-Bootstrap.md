# Phase 0 — Fork bootstrap

**Goal:** branded VSCode fork builds and launches on Linux. Open VSX as the extension gallery. CI builds it.

**Demo at end:** `./scripts/code.sh` opens a window titled "QBee", icon is custom, Settings shows Open VSX as the extension marketplace.

## Tasks

- [ ] Run `./scripts/init-fork.sh` to clone microsoft/vscode into `editor/`
- [ ] First successful editor build: `cd editor && npm install --legacy-peer-deps && npm run watch` then `./scripts/code.sh`
  > Upstream VSCode migrated from yarn → npm. `editor/package-lock.json` is committed; there is no `yarn.lock`.
- [ ] Edit `editor/product.json`:
  - `nameShort: "QBee"`
  - `nameLong: "QBee"`
  - `applicationName: "qbee"`
  - `dataFolderName: ".qbee"`
  - `urlProtocol: "qbee"`
  - `extensionsGallery` → Open VSX endpoints
  - Disable telemetry-related properties
- [ ] Replace icon assets in `editor/resources/linux/`
- [ ] Add fork-only contribution skeleton at `editor/src/vs/workbench/contrib/qbee/qbee.contribution.ts` (just registers a stub, doesn't do anything yet)
- [ ] GitHub Actions workflow that builds the editor on Linux
- [ ] Tag the upstream commit we forked from in the commit message of the first fork commit (makes future rebases easier)

## Critical files

| File | Why we touch it |
|---|---|
| `editor/product.json` | Branding, gallery URL, telemetry off. **The only upstream-shared file we modify.** |
| `editor/src/vs/workbench/contrib/qbee/` | All fork-only code lives here forever. |
| `editor/resources/linux/code.png` (and friends) | Icons |
| `editor/build/lib/electron.ts` | App icon for Electron packager |

## Verification

1. `./scripts/code.sh` opens a window with the new name and icon
2. Help → About shows "QBee"
3. Extensions tab shows results from Open VSX (search "vim" → finds the vscodevim extension)
4. CI green on Linux build
5. No Microsoft sign-in prompts at startup

## Gotchas to watch for

- VSCode upstream now uses **npm** in `editor/` (was yarn classic until late 2024). Don't `pnpm install` inside `editor/` — it'll break.
- The first build is slow (15-30 min). Subsequent watch rebuilds are fast.
- `product.json` has many properties; copy from upstream and only override what you need to keep diffs minimal.

## Rebase discipline

Every commit in this phase should be prefixed `qbee:` so they're easy to identify during future upstream rebases. Example: `qbee: brand product.json`, `qbee: switch gallery to Open VSX`.

## Next: [[Phase-1-Plumbing]]
