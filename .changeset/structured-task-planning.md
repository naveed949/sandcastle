---
"@ai-hero/sandcastle": minor
---

Add a deterministic single-task planner stage with schema-validated structured
plans, immutable task and repository provenance, durable evidence, Mission
Control projection, and resumable cancellation and timeout outcomes.

Planner provenance is validated against claim-time evidence: task snapshots,
repository profiles, eligibility decisions, and dependency evidence must match
the retained claim or the stage fails closed; unrelated claim snapshots and
plan IDs reused with different immutable input are rejected. Claim-time
snapshots retain policy-normalized dependency edges, authorization flows from
the claim-time eligibility refresh into the planner result, and prompt
templates must instruct the `<plan>` structured output tag before any agent
invocation.
