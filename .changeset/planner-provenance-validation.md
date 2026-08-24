---
"@ai-hero/sandcastle": patch
---

Fail closed when planner task, profile, eligibility, or dependency provenance
does not match claim-time evidence, derive one-task planning from the
claim-time eligibility decision, reject unrelated claim snapshots and plan IDs
reused with different immutable input, and preserve cancellation/timeout
classification when an agent aborts with its own error.
