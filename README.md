# Branch Sync Workbench

A local workbench for adapting changes between branches or repositories with different architectures. It keeps shared pair knowledge and evidence in versioned JSON, and keeps checkout paths, jobs, logs, and worktrees under `.local/`.

## Start on Windows

Open this cloned folder in Cursor, run **`/setup`** in Agent chat, then connect your repositories in the web app.

Setup installs missing prerequisites, checks Cursor CLI sign-in, builds the tool, and opens the browser. If the CLI is already authenticated, it skips login. Repository paths and branches are chosen only in the web app. Your source and target repositories must already be cloned.

Next time, double-click **Start Workbench.cmd**. To stop the background server, double-click **Stop Workbench.cmd**. Keep active jobs running until they finish, or cancel them in Activity before stopping.

The first-run guide connects the existing MCP and SEP/ACP presets. Choose a pair, browse to the checkout folders, and check the branches. **Save and analyze** validates the preset's baseline and remotes, saves your paths locally, and starts the normal analysis workflow. Advanced settings remain in Configuration. Changing shared branches requires acknowledgement because pending approvals may need renewal.

Setup supports Windows PowerShell 5.1. It reuses Node.js 24/npm 11 or installs a private runtime under `.local/tools`; it uses WinGet for missing Git and Cursor's official installer for missing Cursor CLI. System installation prompts and browser sign-in may still require your input. Failed steps explain how to retry. Rerunning setup preserves existing bindings and provider choices.

If a port is occupied, use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Port 4318`. Later launches remember the port. Build and install errors are in `.local/setup.log`; server errors are in `.local/server-error.log`. Manual launches and development servers should be stopped from their terminals.

For manual setup (Node.js 24, npm 11, Git, and a supported coding-agent CLI required):

```powershell
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4317>. The backend listens only on loopback. It serves the built React app, checks browser origins, and requires a per-process token for changes. Start the server before using the CLI.

For development, run `npm run dev` and `npm run dev:web` in separate terminals. The Vite app is at <http://127.0.0.1:5173> and proxies API calls to the backend. Rebuild `@sync/engine` after changing engine source.

## Configure pairs

Two editable presets are in `data/pairs/`. The MCP preset is bound locally to `C:\Users\Admin\Work\MCP-Frontend-replacement`. SEP and ACP checkout bindings remain unset until the correct repositories are provided. The workbench does not modify existing checkouts during configuration or scans. The MCP checkout currently has a modified `package-lock.json`; it remains untouched.

Pair JSON contains refs, architecture rules, mappings, and validation commands. `.local/bindings.json` contains absolute paths and each developer's selected AI provider and is Git ignored. The guided Configuration page can discover available refs after paths are saved; an advanced JSON editor remains available. A legacy `provider` key in pair JSON is ignored. Credentials remain in Git and the installed agents.

The seeded MCP offline scan reports zero source integration events after its baseline. This only describes post-baseline change coverage; it does not establish complete migration parity. SEP's baseline is seeded, but its local paths and architecture mappings still require verification against the actual repositories.

## Workflow

1. Select a pair and Fetch & analyze. The selected AI tool reads relevant source and target docs and code at the scanned commits, classifies each behavior, and groups related source events into porting decisions. Use Offline scan explicitly when working from cached refs. A failed AI run leaves the Git scan visible but does not present unassessed events as porting decisions.
2. Review the short decision list. It shows port candidates and uncertain behavior first; use the filter to inspect no-port decisions. Open a decision for impact, evidence, related PRs and commits, and the next action. Detailed workflow controls stay under “Open detailed workflow and controls.” Every uncertain behavior stays `needs_investigation`. If all reviewed requirements need no target implementation, record a no-work resolution with identity, reason, and evidence.
3. Generate and edit a Plan. A plan needs exact target files, behavior, checks, and no unresolved questions.
4. Approve the plan with your identity. This binds its hash, source and target commits, and pair configuration.
5. Implement in a dedicated target worktree. The workbench creates `codex/sync-...` and checks changed files against the approved scope. On Windows, worktrees that would exceed the path limit are created under `%USERPROFILE%\wt`.
6. Run required build and tests, enter manual scenario outcomes, and run a fresh independent review session.
7. Commit, push, and merge with ordinary Git tools. Enter the resulting target commit and verification evidence to confirm integration.

The workbench does not commit, push, merge, or deploy. Failed and interrupted worktrees are retained for inspection. A backend restart marks unfinished jobs as interrupted in `.local/jobs/`.

## CLI

All CLI operations call the running backend, so they use the same job queue and approval gates as the app.

```powershell
npm run cli -- workspace-health
npm run cli -- find-gaps --pair mcp-legacy-angular21 --offline
npm run cli -- plan-gap --pair PAIR --gap GAP
npm run cli -- approve-sync --pair PAIR --gap GAP --by NAME
npm run cli -- implement-gap --pair PAIR --gap GAP
npm run cli -- review-sync --pair PAIR --gap GAP
npm run cli -- record-sync --pair PAIR --gap GAP --integrated-sha SHA --evidence "Verified on target"
npm run cli -- sync-status --pair PAIR
```

The CLI prompts for agent permission and clarification responses while a job runs. The web Activity tray and CLI follow job updates through `/api/jobs/:id/events` (SSE); the stream sends a current snapshot on connection and updates until completion. API jobs also expose `/api/jobs/:id`, `/api/jobs/:id/interactions/:interactionId`, and cancellation.

For a handoff usability check, use [the developer walkthrough](docs/usability-walkthrough.md).

## Data and limits

`data/` holds shared pair configs, snapshots, gap records, plan revisions, approvals, integration records, and generated Markdown reports. `.local/` holds bindings, run records, job history, and worktrees. JSON is authoritative. Runs do not automatically clean worktrees.

Current gaps against the full plan: authenticated Cursor and Claude Code smoke runs are outstanding. The correct SEP/ACP repositories and verified mappings will be configured later. No real post-baseline MCP gap exists at the inspected refs, so the prescribed real-gap acceptance run cannot be completed from this preset. Integration confirmation checks reviewed file content and commit reachability. Later scans reopen integrations when the commit disappears from target history or reviewed files change; full automatic behavioral reanalysis and dependency change detection remain outstanding.

## Checks

```powershell
npm run typecheck
npm test
npm run build
```

Provider interface references: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Cursor ACP](https://cursor.com/docs/cli/acp), [Claude Code CLI](https://code.claude.com/docs/en/cli-reference).
