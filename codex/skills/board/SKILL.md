---
name: board
description: Use when the user requests the Superagent job board or ownership conflicts in Codex.
---

# Superagent board

Run the installed plugin's board command, then report its output accurately.

The plugin root is three directories above this skill directory. Run:

```sh
node "<plugin-root>/codex/command.mjs" board
```

The script uses `CODEX_THREAD_ID`. If unavailable, pass `--session` with the actual current thread id. Report a missing id; never guess one or read another thread's board.
