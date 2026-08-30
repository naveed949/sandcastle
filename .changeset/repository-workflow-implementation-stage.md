---
"@ai-hero/sandcastle": minor
---

Add an implementation stage that executes one accepted plan in the correct
repository and isolation boundary: execution is bound to the plan's frozen
task revision, captured base commit, and repository profile; worktree and
branch identities stay repository-scoped; stage timeout and operator
cancellation reach agent and command subprocesses through AbortSignal paths;
verification evidence now records per-command duration and bounded output;
and attempts already started by a crashed run are never re-executed.
