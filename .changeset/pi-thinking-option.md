---
"@ai-hero/sandcastle": patch
---

Add `thinking` option to `pi()` agent provider to control thinking level via `--thinking` flag. Supports both embedded model syntax (`pi("sonnet:high")`) and explicit option (`pi("sonnet", { thinking: "high" })`). Explicit option wins when both are provided.