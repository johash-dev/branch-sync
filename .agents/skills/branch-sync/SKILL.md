---
name: branch-sync
description: Inspect and advance a Branch Sync Workbench pair through the shared backend workflow.
---

Run the workbench server with `npm start` from the toolkit repository. Use `npm run cli -- <command>` for `workspace-health`, `find-gaps`, `plan-gap`, `approve-sync`, `implement-gap`, `review-sync`, `record-sync`, and `sync-status`. Ask the developer for pair and gap IDs when missing. Never treat an agent's plan approval as workbench approval. Show evidence and the exact plan before `approve-sync`; a developer must explicitly name themselves for that action. Do not commit, push, merge, or alter existing checkouts through this wrapper. CLI jobs share the backend queue and expose permissions and questions interactively.
