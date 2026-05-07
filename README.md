# QBee

A Linux-first, open-source AI code editor built as a fork of VSCode. Inspired by Cursor, but every byte of AI plumbing is yours — local models (llama.cpp, LM Studio, Ollama), Anthropic, or Google Gemini, your choice per request.

> **Status:** early development. See `docs/07-Claude/current-task.md` for what's actually working today.

## Features (planned)

- Inline FIM completions backed by any OpenAI-compatible endpoint
- Sidebar chat with `@file` and `@codebase` mentions
- Agentic multi-file edits with diff approval and checkpoint/undo
- Local RAG over your workspace via `sqlite-vec` + tree-sitter chunking
- AppImage distribution; auto-update from GitHub releases

## Quick start (developers)

```sh
git clone <this-repo> ~/projects/qbee
cd ~/projects/qbee
./scripts/init-fork.sh        # one-time: clones microsoft/vscode into editor/ (~150 MB)
pnpm install                  # install spa/worker/shared deps
cd editor && npm install --legacy-peer-deps   # editor deps (upstream switched to npm)
cd ..
./tmux-dev.sh                 # opens dev session with all watchers
```

In the `run` window, hit the running editor.

> **Node version:** the editor pins Node 22.x via `editor/.nvmrc`. `tmux-dev.sh`
> auto-prepends `~/.local/opt/node-22/bin` to the build/run pane PATH; install
> Node 22 there if you don't already have it system-wide.

## Releasing an AppImage

```sh
# Local dry-run on x64 (the gulp step is 15-30 min on first build)
ARCH=x64 VERSION=0.1.0 ./scripts/build-appimage.sh
# → .build/dist/QBee-0.1.0-x86_64.AppImage (+ .sha256)
```

Tag-driven CI release (after pushing to a GitHub remote):

```sh
git tag v0.1.0
git push --tags
```

This kicks `.github/workflows/release.yml` which:

- builds the AppImage for x64 and arm64 in parallel
- computes SHA-256 checksums
- creates a GitHub Release with both AppImages + checksums attached

### Before your first release

Three things have to be done outside the agent (Phase 0/6 deferrals):

1. **Pick artwork.** Drop a 256×256+ PNG at `scripts/appimage/qbee.png`. The CI workflow generates a placeholder if you push a tag without one, but you'll want real art before sharing the link.
2. **Set up a GitHub remote.** `git remote add origin git@github.com:<you>/qbee.git && git push -u origin main`. The release workflow needs Actions enabled and `contents: write` permission (the workflow already declares it; you just need a default-permissive `GITHUB_TOKEN` or to relax the per-repo Actions permission to "Read and write").
3. **Decide on signing later.** GPG signing is wired into the docs but not the workflow yet — see Phase 6 limitations below.

### Phase 6 limitations (today)

- **No GPG signing yet.** The release ships AppImages + SHA-256 checksums; full GPG signing pulls in CI secret management and is the next iteration.
- **No in-app updater yet.** Users re-download from GitHub Releases on each version bump.
- **Worker isn't bundled into the AppImage.** AI features need the standalone worker (`pnpm --filter @qbee/worker dev`) running on `127.0.0.1:8421` for now. Phase 6.5 adds `spaProxyService` + `workerManager` so the editor self-hosts the worker on a loopback port and the AppImage becomes a single self-contained binary.
- **`fuse2` requirement.** AppImage runtime needs `libfuse2` on the user's host. Ubuntu 22.04+: `apt install libfuse2t64`. Arch/CachyOS: present by default. Document on your release page.

## Layout

| Path | Component |
|---|---|
| `editor/` | Fork of microsoft/vscode (git submodule) |
| `spa/` | React+Vite AI panel |
| `worker/` | Node AI worker (providers, agent, RAG) |
| `shared/` | Zod schemas shared between spa & worker |
| `docs/` | Obsidian vault — architecture, ADRs, runbooks |

See `CLAUDE.md` for the developer/agent contract and `docs/01-Architecture.md` for the design.

## License

MIT (inherited from microsoft/vscode).
