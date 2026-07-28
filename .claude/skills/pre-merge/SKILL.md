---
name: pre-merge
description: Run the full pre-merge verification suite (matching CI exactly) before pushing changes or opening a PR. Use whenever the user asks to check everything passes, or before pushing any non-trivial change.
---

Delegate to the `pre-merge-checker` subagent and surface its full report back to the user verbatim (per-check pass/fail, not just a summary).

If everything passes, remind the user that this only means CI will likely pass — it does not imply merge approval. If anything fails, do not attempt to silently fix it yourself; report what failed and ask how they'd like to proceed.
