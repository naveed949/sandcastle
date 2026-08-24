---
"@ai-hero/sandcastle": minor
---

Add revision-checked, idempotent Mission Control runtime controls for run-now,
pause, resume, and active-execution cancellation. Requests and outcomes are
retained in a secret-redacted append-only operator audit; pause and resume
preserve the worker's single polling loop and cancellation uses the existing
abort path.
