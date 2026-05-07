#!/usr/bin/env bash
# init-fork.sh — one-time clone of microsoft/vscode into editor/.
#
# This is heavy (~150 MB, full history). Run once.
# Subsequent rebases against upstream use docs/05-Runbooks/Rebase-Upstream.md.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EDITOR_DIR="$PROJECT_DIR/editor"

if [ -d "$EDITOR_DIR/.git" ]; then
  echo "editor/ already initialized. To rebase, see docs/05-Runbooks/Rebase-Upstream.md"
  exit 0
fi

echo "Cloning microsoft/vscode into editor/ — this is ~150 MB and takes a few minutes…"
git clone https://github.com/microsoft/vscode.git "$EDITOR_DIR"

cd "$EDITOR_DIR"
git remote rename origin upstream
echo
echo "Set 'upstream' = microsoft/vscode."
echo "Now run: 'cd editor && git remote add origin <YOUR-FORK-URL>' to point at your fork."
echo
echo "Next: 'cd editor && git checkout -b main-fork' to start a fork branch."
echo "Then: 'yarn && yarn watch' to build the editor for the first time."
echo
echo "After that, follow docs/02-Phases/Phase-0-Bootstrap.md to brand the fork."
