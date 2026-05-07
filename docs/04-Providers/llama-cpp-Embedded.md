# Embedded llama.cpp (deferred — Phase 7)

Optional path: link `llama.cpp` directly via `node-llama-cpp` instead of relying on a separate server. Trades flexibility for UX (no server to start).

## When to enable

- After Phases 0-6 ship and the OpenAI-compat path is solid
- For users who want "double-click to chat" with no Ollama/LM Studio dependency

## Library

`node-llama-cpp` — TypeScript-first wrapper, prebuilt binaries, supports CUDA / Metal / Vulkan / CPU.

## Architecture impact

- Adds an alternative `Provider` implementation: `LocalLlamaProvider`
- Worker bundles `node-llama-cpp` and prebuilt binaries → AppImage size goes up by ~50-100 MB
- Model files are NOT bundled (way too big) — provide UI to download a default model from Hugging Face

## Default model recommendations

- Chat: `Qwen2.5-Coder-7B-Instruct.Q4_K_M.gguf` (~4.5 GB)
- FIM: `Qwen2.5-Coder-1.5B.Q5_K_M.gguf` (~1.1 GB)
- Embeddings: `nomic-embed-text-v1.5.Q4_K_M.gguf` (~95 MB)

Store under `~/.config/qbee/models/`.

## Things to plan for

- **GPU detection** — RX 7600 XT (this user) needs Vulkan. Detect and configure accordingly.
- **First-launch UX** — "We need to download a model (~1 GB). Continue?" with progress bar.
- **Model swapping** — unload before loading a new one to avoid OOM.
- **AppImage and dlopen** — `node-llama-cpp` uses dlopen for the backend; AppImage's bundled libs need `LD_LIBRARY_PATH` discipline.
