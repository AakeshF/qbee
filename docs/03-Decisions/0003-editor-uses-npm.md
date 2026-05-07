# ADR 0003 — `editor/` uses npm (not yarn)

**Date:** 2026-05-06
**Status:** Accepted

## Context

The original plan and CLAUDE.md said: "VSCode upstream uses yarn classic in `editor/`. The outer workspace uses pnpm; `editor/` is the only yarn." On Phase 0 first build, this turned out to be wrong.

When we cloned `microsoft/vscode` at upstream `98cb242836`, we found:
- `editor/package-lock.json` (no `yarn.lock`)
- No `.yarnrc`, no `packageManager` field
- All scripts call `npm run gulp …` (e.g. `"watch": "npm-run-all2 -lp watch-client-transpile watch-client …"`, `"compile": "npm run gulp compile"`)
- `editor/build/npm/preinstall.ts` (the directory itself is named `npm`)

VSCode upstream migrated from yarn classic to npm sometime in 2024/2025.

## Decision

Use `npm install --legacy-peer-deps` and `npm run watch` inside `editor/`.

(`--legacy-peer-deps` is already set in `editor/.npmrc`; passing the flag explicitly is redundant but harmless.)

## Why

- Following upstream's package manager keeps rebases trivial. Switching back to yarn would require regenerating `yarn.lock` from `package-lock.json` every rebase and risks dependency drift.
- `editor/.npmrc` already pins `runtime=electron`, `target=39.8.8`, etc. — npm picks those up natively.

## Implications

- CLAUDE.md updated: "Use pnpm at the workspace root. Inside `editor/` use npm — never `pnpm install` there."
- `docs/02-Phases/Phase-0-Bootstrap.md` updated: build command is `cd editor && npm install --legacy-peer-deps && npm run watch`.
- We do not need yarn installed at all. (`~/.local/bin/yarn` was installed during Phase 0 before the discovery; it can be removed but is harmless.)

## Trade-offs

- npm installs of VSCode are slower than yarn classic was. Acceptable; only matters at first install + after rebases.
