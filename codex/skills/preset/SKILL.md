---
name: preset
description: Use when the user requests a Superagent preset change or wants to inspect available presets in Codex.
---

# Superagent preset

The plugin root is three directories above this skill directory. Run:

```sh
node "<plugin-root>/codex/command.mjs" preset
```

Pass a requested preset and optional `--persist` as literal, shell-quoted arguments. The script uses `CODEX_THREAD_ID`; pass the actual current id with `--session` if needed. Report the output, including any instruction to refresh roles and start a new session. Never report that an already-loaded role or model changed immediately.
