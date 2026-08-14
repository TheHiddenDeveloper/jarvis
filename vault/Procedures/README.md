# Procedures

Multi-step desktop task procedures. Written by `save_procedure` (or a direct vault
write). Each note follows this template:

```yaml
---
title: "<Task Name>"
status: active
created: YYYY-MM-DD
last_verified: YYYY-MM-DD
tags: [engineering, procedures, jarvis, desktop]
---
```

- **Trigger phrases** — spoken/typed phrasings that should invoke this procedure (used for recall).
- **Preconditions** — required starting state before step 1.
- **Steps** — numbered; each has an **Action** (tool + args) and an **Expect** (the on-screen state to verify with a screenshot before proceeding).
- **Failure handling** — what to do when a step's expected state isn't met.
- **Last verified** — refreshed whenever the procedure runs successfully.

Referenced landmarks live in `../Screen/Landmarks.md`.
