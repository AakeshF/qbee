# Runbook — Rebase the fork on `microsoft/vscode:main`

The fork is a git submodule under `editor/`. Upstream moves fast. Rebase regularly (monthly minimum) to keep the diff small.

## Strategy

All fork-only commits are prefixed `qbee:` and live on a `main-fork` branch. Rebase that branch onto upstream `main`.

## Steps

```sh
cd ~/projects/qbee/editor
git remote -v             # verify: 'origin' = your fork, 'upstream' = microsoft/vscode
git fetch upstream
git checkout main-fork
git rebase upstream/main
```

Conflicts are almost always in `product.json` (we modified it; upstream did too). Resolve by:
1. Take upstream changes
2. Re-apply our overrides (`nameShort`, `applicationName`, `extensionsGallery`, telemetry off)

If there are conflicts in `src/vs/workbench/contrib/qbee/` — that should never happen because upstream doesn't touch that directory. If it does, something is wrong (someone added a file there upstream? Unlikely but possible).

## After successful rebase

```sh
yarn                      # may need to re-install if package.json changed upstream
yarn watch                # rebuild
./scripts/code.sh         # smoke test the editor still launches
```

Run through Phase 0 verification (window opens, branding correct, Open VSX gallery works). If anything broke, the new diff against upstream is the smoking gun.

```sh
git push --force-with-lease origin main-fork
```

`--force-with-lease` (not `--force`) protects against overwriting someone else's work.

## When upstream does something disruptive

VSCode's release notes call out major API changes. Watch for:
- Workbench contribution API changes (rare but big)
- Webview / iframe security tightening
- Electron major version bumps (need to rebuild native modules)

If a rebase produces a non-trivial conflict pattern, write an ADR in `docs/03-Decisions/` explaining the workaround. Future rebases will hit the same thing.

## Slash command

`/rebase-upstream` automates the fetch + rebase + smoke-test loop and surfaces conflicts to the user.
