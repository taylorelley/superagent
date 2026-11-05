---
name: update
description: Use when the user requests the installed Superagent version or wants to check for or install a Superagent update in Codex.
---

# Superagent update

The plugin root is three directories above this skill directory. Run:

```sh
node "<plugin-root>/codex/command.mjs" update
```

Use `update check` for an explicit cached update check. Use `update install` only when the user requests installation; it updates the native plugin and refreshes role files. The script uses `CODEX_THREAD_ID`; pass the actual current id with `--session` if needed. Report installed and latest-known versions separately. An instruction to update is not evidence that an update was installed. Preserve the restart notice.
