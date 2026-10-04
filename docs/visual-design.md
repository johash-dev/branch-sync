# Branch Sync visual system

## Product and audit

Branch Sync is a local engineering workbench for adapting changes between repositories with different architectures. Its central tasks are reviewing source changes and evidence, approving implementation plans, following worktree execution, validating results, and recording integration. The existing dashboard → pair → decision hierarchy and configuration destination are retained.

The previous interface gave queue entries, metrics, setup, evidence, and supporting information similar rounded, elevated cards. Repeated teal emphasis and small placeholder glyphs weakened hierarchy. Decision descriptions were clipped, mobile navigation hid text labels, and evidence columns did not stack on phones.

## Direction

A precise, understated engineering workbench: graphite navigation, warm neutral working surfaces, blue actions, and semantic green/amber/red status. Typography, alignment, rules, and space distinguish different kinds of content. Shadows belong to overlays.

- Queue: continuous rows with readable context and quiet navigation actions.
- Repository pairs: comparable records with aligned monospace metrics.
- Decisions: readable summaries, complete descriptions, and paired evidence columns.
- Configuration: numbered sections, consistent fields, restrained selection treatments.
- Workflow: one continuous stage navigation bar; the selected stage has an underline and background.
- Activity: an overlay with distinct job records and attention states.

## Maintenance

`packages/web/src/style.css` owns shared tokens and component rules. Use `--ink`, `--muted`, `--line`, `--accent`, surface, and semantic status variables rather than adding screen-specific palettes. Spacing follows a 4/8px rhythm (`--space-1` through `--space-6`). Segoe UI/system sans handles prose and controls; `--mono` and tabular figures identify technical metadata and metrics. Motion uses the shared duration and easing tokens. No hosted fonts, animation libraries, or new dependencies are required.

Keep normal controls around 38–40px tall, and 44px on coarse pointers. Field labels stay legible, corners stay modest, and action emphasis stays proportional to consequence. Use `Icon.tsx` for consistent decorative line icons, with visible text or an accessible label on the surrounding control. Preserve native form controls and their existing handlers. One strong focus ring is shared. Shadows stay on overlays.

The gap workspace is a decision header, a Next Action strip, and a six-stage rail: Evidence, Plan, Approve, Implement, Validate, Review. Evidence is one editable surface for the decision, rationale, and source/target evidence; source history stays in a secondary disclosure. Plan groups Behavior, Scope, Verification, and Questions, and approval is a separate immutable summary of the saved revision. Each stage exposes complete, current, available, or blocked as text, not color alone. The visible stage keeps one primary action. Wide screens use a horizontal rail. At 900px and below the rail scrolls horizontally and keeps its labels. At 1180px navigation and page gutters tighten; at 900px pairs stack; at 740px navigation becomes a labeled top bar and forms stack; at 600px setup paths stack. The page uses `min-height: 100dvh`. Mobile fields use 16px text. A skip-to-content link remains.

## Motion

Accepted, because each one is occasional or gives feedback without moving content the user is reading:

- Activity drawer: symmetric `translateX` and opacity, about 220ms, with a 160ms backdrop fade.
- Toasts: 8px and opacity entrance at 160ms, exit at 120ms.
- Validation progress: transform `scaleX` fill at 180ms, and a 140ms status settle.
- Fine-pointer buttons: at most a 100ms `scale(0.98)` press.

Rejected: animated route or stage changes, staggered record or diff entrances, auto-scrolling or reordering Activity entries, decorative loading motion, parallax, and celebration. Keyboard stage changes stay immediate. Under `prefers-reduced-motion`, movement and sweeps become static state changes; color and opacity cues remain.

## Stage and status matrix

| State | How it is shown |
| --- | --- |
| Stage complete, current, available, blocked | Text on the stage control, with `aria-current="step"` on the current stage |
| Unsaved Evidence or Plan | Visible “Unsaved changes” and a confirmation before leaving |
| Validation passed, failed, non-blocking, pending, running | Checklist text, not color alone |
| Job connected, reconnecting, cancelled, interrupted, failed | Distinct sentences in Activity |
| Quiet running check | “Still running” after 20 seconds without output; Cancel stays available |
| Agent plan consent | “Agent execution consent”; it is separate from workbench approval |

## Verification (2026-09-30)

- Frontend production build passed; Vite reports dependency `use client` directives ignored during bundling.
- TypeScript check passed.
- Existing test suite: 6 files, 18 tests passed.
- Browser checks covered desktop (1440px), tablet (1024px), phone (390px), and narrow phone (320px) layouts.
- Exercised scan-menu disclosure, evidence disclosure, all five workflow stages, guided/JSON editor switching, and Activity opening/closing without executing jobs or saving configuration.
- Checked document overflow on the sampled screens and corrected narrow-screen drawer overflow.
- Checked contrast for key text, action, and status token pairs; corrected placeholder and step-number contrast.

The 2026-09-30 pass changed presentation and small accessibility details. A later pass adds the six-stage workspace, Activity dialog, and validation progress described above. Routes stay the same. Commit, push, and merge stay outside the app. A fresh developer still needs to score the walkthrough in `docs/usability-walkthrough.md`.
