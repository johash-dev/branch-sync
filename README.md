# Branch Sync Workbench

A local workbench for adapting changes between branches or repositories that do not share the same architecture.

Shared pair knowledge lives in versioned JSON under `data/`. Checkout paths, jobs, logs, and worktrees live under `.local/` and are not committed.

## Before you start

- Windows with PowerShell 5.1
- This repo open in Cursor
- Source and target repositories already cloned

Setup installs anything else that is missing: Node.js 24, npm 11, Git, and the Cursor CLI. It reuses tools you already have. Installer prompts and browser sign-in may still need you.

## First-time setup

1. In Cursor Agent chat, run `/setup`.
2. Let it finish. If the browser asks you to sign in to Cursor, complete that and wait for setup to continue.
3. When the workbench opens, choose a pair.
4. Browse to the source and target checkout folders and confirm the branches.
5. Click **Save and analyze**.

That saves paths on this machine, checks the preset baseline and remotes, and starts analysis. Choose repository paths and branches in the web app, not in chat.

Running setup again keeps existing bindings and the selected AI provider.

## Start and stop

1. Double-click **Start Workbench.cmd**.
2. Use the app at the address it opens. The default is <http://127.0.0.1:4317>.
3. Finish or cancel jobs in Activity, then double-click **Stop Workbench.cmd**.

The server listens only on loopback. Later launches reuse the last port.

## If setup fails

1. Read the terminal message. It says how to retry.
2. Install and build details are in `.local/setup.log`. Server errors are in `.local/server-error.log`.
3. Run `/setup` again, or double-click **Start Workbench.cmd**.

If port 4317 is already in use:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Port 4318
```

Stop a manual or development server from its own terminal. **Stop Workbench.cmd** only stops the background server this launcher started.

## Manual setup

Use this when you are not using `/setup`. You need Node.js 24, npm 11, Git, and a supported coding-agent CLI.

```powershell
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4317>. Start the server before using the CLI.

## Local development

Use two terminals:

```powershell
npm run dev
```

```powershell
npm run dev:web
```

The Vite app is at <http://127.0.0.1:5173> and proxies API calls to the backend. Rebuild `@sync/engine` after changing engine source.

## Connect a pair

Presets are in `data/pairs/`:

- `mcp-legacy-angular21` — MCP legacy to Angular 21
- `sep-acp` — SEP to ACP

1. Open the first-run guide, or Configuration.
2. Choose the pair and point it at your existing checkouts.
3. Confirm the refs. Configuration can discover refs after the paths are saved.
4. Save. Paths and your AI provider go in `.local/bindings.json` (Git ignored). Rules, mappings, and validation commands stay in the pair JSON.

The workbench does not modify those checkouts during configuration or scans. Changing a shared branch asks for acknowledgement, because pending approvals may need renewal. An advanced JSON editor remains in Configuration. A `provider` key inside pair JSON is ignored. Credentials stay in Git and in the installed agents.

## Sync one change

1. Select a pair and run **Fetch & analyze**. The selected AI tool reads source and target docs and code at the scanned commits, classifies each behavior, and groups related source events into porting decisions. Use **Offline scan** when working from cached refs. A failed AI run still shows the Git scan, and it does not present unassessed events as decisions.
2. Review the short decision list. Port candidates and uncertain behavior come first. Use the filter for no-port decisions. Open a decision for impact, evidence, related PRs and commits, and the next action. Extra controls are under **Open detailed workflow and controls**. Uncertain behavior stays `needs_investigation`. If nothing needs a target change, record a no-work resolution with your name, a reason, and evidence.
3. Generate a plan and edit it until it has exact target files, the behavior, the checks, and no open questions.
4. Approve the plan with your name. Approval binds the plan hash, the source and target commits, and the pair configuration.
5. Implement in a dedicated target worktree. The workbench creates `codex/sync-...` and checks changed files against the approved scope. On Windows, worktrees that would exceed the path limit are created under `%USERPROFILE%\wt`.
6. Run the required build and tests, enter manual scenario results, and run a fresh independent review.
7. Commit, push, and merge with your normal Git tools. Enter the resulting target commit and verification evidence to confirm integration.

The workbench does not commit, push, merge, or deploy. Failed and interrupted worktrees are kept for inspection. A backend restart marks unfinished jobs as interrupted in `.local/jobs/`.

For a handoff check, use [the developer walkthrough](docs/usability-walkthrough.md).

## CLI

CLI commands call the running server, so they use the same job queue and approval gates as the app. The CLI prompts for agent permission and clarification while a job runs.

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

The web Activity tray and the CLI follow job updates through `/api/jobs/:id/events`.

## Where data lives

- `data/` holds shared pair configs, snapshots, gap records, plan revisions, approvals, integration records, and generated Markdown reports. JSON is authoritative.
- `.local/` holds bindings, run records, job history, and worktrees. Runs do not clean worktrees automatically.

## Checks

```powershell
npm run typecheck
npm test
npm run build
```

## Known limits

- Authenticated Cursor and Claude Code smoke runs are still outstanding.
- SEP/ACP local paths and architecture mappings still need verification against the actual repositories.
- The seeded MCP preset has no real post-baseline gap at the inspected refs, so that acceptance run cannot be completed from this preset alone.
- Integration confirmation checks reviewed file content and commit reachability. A later scan reopens an integration when the commit disappears from target history or reviewed files change. Full automatic behavioral reanalysis and dependency change detection are still outstanding.

Provider docs: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Cursor ACP](https://cursor.com/docs/cli/acp), [Claude Code CLI](https://code.claude.com/docs/en/cli-reference).
