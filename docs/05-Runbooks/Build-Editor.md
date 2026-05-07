# Runbook — Build the editor

## First time

```sh
cd ~/projects/qbee
./scripts/init-fork.sh    # clones microsoft/vscode into editor/ (~150 MB, one-time)
cd editor
yarn                      # ~5-10 min, installs editor deps with yarn classic
yarn watch                # starts TSC watch — leave running in a tmux pane
```

In a separate pane:
```sh
cd ~/projects/qbee/editor
./scripts/code.sh         # launches the dev build
```

First launch is slow (~30-60 s). Subsequent launches are fast.

## Iterating on the fork

- Edits inside `editor/src/` are picked up by `yarn watch`. Reload window (Ctrl+R) to see changes.
- Native modules don't reload — restart the dev build.
- Changes to `product.json` require a full restart.

## Iterating on the SPA without rebuilding the editor

```sh
cd ~/projects/qbee/spa
pnpm dev                  # Vite HMR on :5173
```

The dev editor's iframe needs to point at `:5173` instead of the vendored bundle. Set `QBEE_SPA_DEV_URL=http://localhost:5173` before launching the editor:

```sh
cd ~/projects/qbee/editor
QBEE_SPA_DEV_URL=http://localhost:5173 ./scripts/code.sh
```

`spaProxyService` reads this env and proxies the iframe to the Vite dev server instead of serving `spa-dist/`.

## Production build

```sh
cd ~/projects/qbee
pnpm -w build             # builds spa, vendors into editor/, then editor production build
```

Output: `editor/.build/electron/QBee` (or similar). Run directly to test.

## Debugging

- VSCode's own renderer DevTools: `Help → Toggle Developer Tools`
- Worker stderr → editor's "QBee Worker" output channel
- SPA console → DevTools → iframe context (switch the dropdown above the console)

## Common failures

- **`yarn watch` errors about native module versions** — run `yarn electron-rebuild` inside `editor/`
- **`pnpm install` errors about workspaces** — make sure you're at the project root (`~/projects/qbee/`), not inside `editor/`
- **Iframe shows "connection refused"** — worker isn't running. Check the `workerManager` output channel.
