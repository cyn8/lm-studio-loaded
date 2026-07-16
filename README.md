# LM Studio for Oh My Pi (loaded only)

An [omp](https://github.com/oh-my-pi) provider plugin that surfaces **only** the LM Studio models currently loaded, each at its applied context length.

It queries LM Studio's native REST endpoint (`/api/v0/models`), the only one that reports load state and the applied context window, and registers a static provider model config for every loaded chat model. Because the list is a point-in-time snapshot, the `lm-studio-refresh` command re-snapshots on demand after you load/unload a model.

## Configuration

Set via environment variables:

- `LM_STUDIO_BASE_URL` — OpenAI-compatible base URL (default `http://127.0.0.1:1234/v1`)
- `LM_STUDIO_OUTPUT_FRACTION` — fraction of context reserved for output, `0`–`1` (default `0.5`)
- `LM_STUDIO_MAX_TOKENS` — optional hard cap on output tokens
