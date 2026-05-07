# Runbook — Debug the worker

The worker is a Node child process. It logs to stdout, which the editor's `workerManager` forwards to the "QBee Worker" output channel.

## Inspect logs

In the running editor: `View → Output → "QBee Worker"` from the dropdown.

## Run the worker standalone

Useful when you want to hit it with `curl` / `httpie` directly without an editor running.

```sh
cd ~/projects/qbee/worker
QBEE_WORKER_PORT=8421 QBEE_WORKER_AUTH=test pnpm dev
```

Then:
```sh
curl -u test:test http://localhost:8421/api/echo -d '{"message":"hi"}'
```

## Attach a debugger

```sh
cd ~/projects/qbee/worker
QBEE_WORKER_PORT=8421 pnpm dev:debug   # adds --inspect-brk
```

Open `chrome://inspect`, click "inspect" on the listed Node target.

## Common failures

| Symptom | Likely cause |
|---|---|
| "ECONNREFUSED" in editor | Worker crashed; check output channel |
| Slow `/api/chat` first response | Local model loading from disk; LM Studio/Ollama can take 5-30 s on cold start |
| `/api/embed` returns dim mismatch | Embedding model changed since last index; need full reindex |
| OOM during indexing | Batch size too large; reduce `RAG_BATCH_SIZE` env var |
| 401 on requests from SPA | `QBEE_WORKER_AUTH` env mismatch between editor and worker |

## Restart cleanly

`/restart-worker` slash command handles it. Manually:
```sh
pkill -f 'qbee/worker' && # workerManager respawns automatically
```

## Profiling

Worker emits timing events: `{event: 'timing', op: 'embed', ms: 47}`. Pipe to `jq` for analysis:
```sh
journalctl --user -u qbee-worker -o cat | jq 'select(.event=="timing")'
```

(only relevant if running under systemd — not the default)
