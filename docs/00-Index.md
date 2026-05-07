# QBee — Documentation Index

This vault is the durable memory of the project. Every long session should read [[07-Claude/current-task]] first and write back to it at the end.

## Map

- [[01-Architecture]] — three-process design, data flow
- **02-Phases/** — one note per implementation phase (mirrors the approved plan)
  - [[02-Phases/Phase-0-Bootstrap]]
  - [[02-Phases/Phase-1-Plumbing]]
  - [[02-Phases/Phase-2-Chat-MVP]]
  - [[02-Phases/Phase-3-Inline-FIM]]
  - [[02-Phases/Phase-4-Agent-Mode]]
  - [[02-Phases/Phase-5-RAG]]
  - [[02-Phases/Phase-6-AppImage-Release]]
- **03-Decisions/** — Architecture Decision Records (one note per non-obvious choice)
- **04-Providers/** — per-backend integration notes
  - [[04-Providers/Anthropic]]
  - [[04-Providers/Gemini]]
  - [[04-Providers/OpenAI-Compatible]]
  - [[04-Providers/llama-cpp-Embedded]]
- **05-Runbooks/** — how-to guides
  - [[05-Runbooks/Build-Editor]]
  - [[05-Runbooks/Rebase-Upstream]]
  - [[05-Runbooks/Ship-Release]]
  - [[05-Runbooks/Debug-Worker]]
- **06-Daily/** — daily log, free-form
- **07-Claude/** — Claude Code's working memory
  - [[07-Claude/current-task]] — **start here every session**
  - [[07-Claude/known-issues]] — bugs/gotchas hit and worked around
  - [[07-Claude/conventions]] — patterns established that should persist

## External

- Approved plan: `~/.claude/plans/i-wanna-make-my-quizzical-bee.md`
- Project root: `~/projects/qbee/`
- Project guide for Claude: `../CLAUDE.md`
