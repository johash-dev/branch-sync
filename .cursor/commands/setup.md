# Set up Branch Sync Workbench

Run the project's Windows bootstrap from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

The script installs missing prerequisites, checks Cursor CLI sign-in, builds and
starts the local server, and opens the web app. Let it finish; allow time for the
developer to complete browser sign-in. If the terminal returns a running session,
continue following that session until completion.

Do not ask for repository paths, branches, or pair settings in chat. All repository
configuration belongs in the web app. Do not modify pair JSON or saved bindings.
Do not reinstall tools manually or run a second bootstrap while the first runs.

If setup fails, report its short recovery instruction, resolve routine environment
issues within the user's authorization, and rerun the same script. Never bypass
system policy or change machine-wide execution policy. The script can safely resume.

On success, say: "The workbench is open. Connect your repositories there. Next time,
double-click Start Workbench.cmd." Do not claim Cursor's authenticated ACP workflow
is tested merely because setup or the version check passed.
