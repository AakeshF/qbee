#!/usr/bin/env bash
# tmux-dev.sh — idempotent launcher for the QBee dev session.
# Layout documented in ~/.claude/plans/i-wanna-make-my-quizzical-bee.md.

set -euo pipefail

SESSION="qbee"
PROJECT_DIR="$HOME/projects/qbee"
NODE22_BIN="$HOME/.local/opt/node-22/bin"

cd "$PROJECT_DIR"

# VSCode upstream pins Node 22 via editor/.nvmrc; system Node may be different.
# Prepend our local Node 22 to PATH for the editor build/run panes (sudoless).
node22_setup_fish='if test -d ~/.local/opt/node-22/bin; set -x PATH ~/.local/opt/node-22/bin $PATH; end'
node22_setup_bashzsh='[ -d ~/.local/opt/node-22/bin ] && export PATH=~/.local/opt/node-22/bin:$PATH'

# Pick the right syntax based on the user's shell. tmux inherits SHELL.
case "${SHELL##*/}" in
  fish) NODE22_SETUP="$node22_setup_fish" ;;
  *)    NODE22_SETUP="$node22_setup_bashzsh" ;;
esac

if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach -t "$SESSION"
fi

# ── Window 0: code (shell + 2× claude) ──────────────────────────────
tmux new-session -d -s "$SESSION" -n code -c "$PROJECT_DIR"
# Pane 0 is the shell. Split right for claude main, then split below for claude helper.
tmux split-window -h -t "$SESSION:code.0" -c "$PROJECT_DIR"
tmux split-window -v -t "$SESSION:code.1" -c "$PROJECT_DIR"
tmux send-keys -t "$SESSION:code.1" 'claude' C-m
# Leave code.2 idle — user can launch a second `claude` for parallel work when needed.
tmux select-pane -t "$SESSION:code.1"

# ── Window 1: build (editor watch + spa dev + worker dev) ───────────
tmux new-window -t "$SESSION" -n build -c "$PROJECT_DIR"
tmux split-window -h -t "$SESSION:build.0" -c "$PROJECT_DIR"
tmux split-window -h -t "$SESSION:build.1" -c "$PROJECT_DIR"
tmux select-layout -t "$SESSION:build" even-horizontal

# build.0 — editor TSC watch (only after init-fork). Upstream uses npm + Node 22.
if [ -d "$PROJECT_DIR/editor/.git" ]; then
  tmux send-keys -t "$SESSION:build.0" "$NODE22_SETUP" C-m
  tmux send-keys -t "$SESSION:build.0" 'cd editor && npm run watch' C-m
else
  tmux send-keys -t "$SESSION:build.0" 'echo "editor/ not cloned yet — run ./scripts/init-fork.sh"' C-m
fi
# build.1 — spa Vite dev
tmux send-keys -t "$SESSION:build.1" 'pnpm --filter @qbee/spa dev' C-m
# build.2 — worker tsx watch
tmux send-keys -t "$SESSION:build.2" 'pnpm --filter @qbee/worker dev' C-m

# ── Window 2: run (the editor + local LLM backends) ─────────────────
tmux new-window -t "$SESSION" -n run -c "$PROJECT_DIR"
tmux split-window -v -t "$SESSION:run.0" -c "$PROJECT_DIR"
# run.0 — the running editor (after build is ready). Needs Node 22 on PATH.
if [ -d "$PROJECT_DIR/editor/.git" ]; then
  tmux send-keys -t "$SESSION:run.0" "$NODE22_SETUP" C-m
  tmux send-keys -t "$SESSION:run.0" '# wait for build, then: ./editor/scripts/code.sh' C-m
fi
# run.1 — LLM backends control. Start ollama if installed.
if command -v ollama >/dev/null 2>&1; then
  tmux send-keys -t "$SESSION:run.1" 'ollama serve' C-m
elif command -v lms >/dev/null 2>&1; then
  tmux send-keys -t "$SESSION:run.1" 'lms server start' C-m
else
  tmux send-keys -t "$SESSION:run.1" '# install ollama or lmstudio (lms) to run a local model' C-m
fi

# ── Window 3: docs ──────────────────────────────────────────────────
tmux new-window -t "$SESSION" -n docs -c "$PROJECT_DIR/docs"
tmux send-keys -t "$SESSION:docs.0" 'cat 07-Claude/current-task.md' C-m

# Land on the code window with the main claude pane focused
tmux select-window -t "$SESSION:code"
tmux select-pane -t "$SESSION:code.1"

exec tmux attach -t "$SESSION"
