---
name: council
description: Use when the user requests Superagent council advice from independent configured models in Codex.
---

# Superagent council

The plugin root is three directories above this skill directory. Run:

```sh
node "<plugin-root>/codex/command.mjs" council "<question>"
```

Pass the question as literal, safely quoted data. The script uses `CODEX_THREAD_ID`; pass the actual current id with `--session` if needed. Follow the returned council dispatch and synthesis instructions. If fewer than two usable models are configured, report that limitation instead of inventing councillors. Include dissent and failed participants in the synthesis.
