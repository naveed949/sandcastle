---
"@ai-hero/sandcastle": patch
---

Add MiniMax M2 series models as built-in constants for the `pi` agent provider: `MINIMAX_MODELS.M2_7`, `MINIMAX_MODELS.M2_7_HIGHSPEED`, `MINIMAX_MODELS.M2_5`, `MINIMAX_MODELS.M2_5_HIGHSPEED`, and `MINIMAX_DEFAULT_MODEL`. When `pi()` is called with a model prefixed by `MiniMax-`, `MINIMAX_API_KEY` is injected automatically and `--provider minimax` is added to the pi CLI command. A new `pi-minimax` entry is also added to the `init` CLI agent registry.
