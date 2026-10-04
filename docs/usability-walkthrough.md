# Developer walkthrough

Ask a developer who has not used this workbench to complete these tasks without reading the README first. Use a disposable or safe pair for any write-producing steps. The gap page is the guided workspace: a Next Action strip and the stages Evidence, Plan, Approve, Implement, Validate, and Review. Evidence edits and the saved-plan approval are separate. Activity is a dialog. Agent execution consent is separate from workbench approval. Score “know what to do next” only after a person who did not build this pass completes the list; do not treat an automated check as that score.

1. Find the selected AI tool, switch it to Cursor, and explain what the availability message means.
2. Find Setup for source and target checkout paths, then locate the pair's refs and validation commands in Configuration.
3. From the dashboard, identify the next change and open the stage linked from its status.
4. On Evidence, record classification, rationale, and source and target evidence. Explain why an unsaved edit warns before leaving. For a no-impact change, record the no-work decision and say when a later scan would reopen it.
5. On Plan, answer every question and save. On Approve, confirm the saved revision, name yourself, and explain what approval locks.
6. On Implement, point to the approved scope, the changed-file index, and the diff. Open Activity and explain the job objective, the current action, and how a permission request differs from workbench approval.
7. On Validate, read the current check, completed count, elapsed time, and whether the connection is live. Record an observed note for a manual scenario.
8. On Review, separate independent review, Git handoff, and integration confirmation. Show the links back to the plan, diff, and validation evidence.

Record task completion, confusing moments, and any dead ends. Ask: **“On a scale of 1–10, how easy was it to know what to do next?”** The target is at least 8. Fix blocking findings and repeat the walkthrough before declaring the handoff ready.

## This implementation pass

Automated checks cover stage derivation, no-work and setup routing, unsaved navigation, saved-versus-dirty approval, dialog focus, activity wording, and validation progress. A developer who has not used the workbench still needs to run the tasks above on a safe pair and record the 1–10 score. That live score is the handoff gate; this document does not invent one.

## First-run acceptance

On a clean Windows machine with the tool cloned and Cursor installed:

1. Run `/setup` from Cursor Agent chat. Confirm no repository questions appear in chat.
2. Complete browser sign-in only if the CLI was not already authenticated.
3. In the browser, choose a preset, browse to already-cloned repositories, and confirm the branches. Check that cancelling Browse preserves the path.
4. Click Save and analyze. Confirm the job appears in Activity; complete an authenticated Cursor analysis on a safe fixture with a post-baseline source event.
5. Double-click Start Workbench.cmd again. Confirm the same server is reused and no installation, build, or login is repeated.
6. Stop using Stop Workbench.cmd, then start again. Confirm saved settings are retained.

The automated launcher suite uses isolated Windows fixtures and a simulated Cursor executable; it does not prove real installer downloads or authenticated ACP compatibility. Keep those checks outstanding until performed with a real account on a clean machine.
