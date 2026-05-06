---
"@ai-hero/sandcastle": patch
---

Add `chown -R 1000:1000 /home/agent && chmod 777 /home/agent` to the `pi` agent Dockerfile template (used by `npx sandcastle init`), with an explanatory comment noting that Sandcastle runs containers as the host UID/GID — which on macOS is often not 1000 — so the runtime user can write `~/.gitconfig`.