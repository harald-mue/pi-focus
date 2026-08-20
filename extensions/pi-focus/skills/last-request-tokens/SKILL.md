---
name: last-request-tokens
description: Shows the token summary for the last user request. Use for token debugging.
---

Use `/last-request` for a concise provider-usage summary with estimated breakdown and per-call usage.

Use `/last-request-dump [path]` when the user needs the complete messages, system prompt, and provider payload as JSON. Without a path, the command writes to `~/dumps/last-request-<timestamp>.json`.

Summarize results briefly in English. Mention that provider-reported input can exceed visible prompt text because it may include system instructions, tool schemas, history, reasoning state, or cached context.

Do not expose secrets or paste a full dump into chat unless the user explicitly requests it.
