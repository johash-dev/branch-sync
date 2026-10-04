import type { Gap, PairHealth, Plan, PlanQuestion, Run } from "./types.js";

export function unansweredPlanQuestions(questions: readonly PlanQuestion[]) {
  return questions.filter((item) => {
    const question = typeof item === "string" ? item : item.question;
    const answer = typeof item === "string" ? "" : item.answer;
    return question.trim().length > 0 && !answer.trim();
  });
}

export type StageId =
  | "evidence"
  | "plan"
  | "approve"
  | "implement"
  | "validate"
  | "review";
export type StageState = "complete" | "current" | "available" | "blocked";
export type WorkflowStage = {
  id: StageId;
  label: string;
  state: StageState;
  blocker?: string;
};
export type NextStep = {
  title: string;
  detail: string;
  action: string;
  section: "Evidence" | "Plan" | "Changes" | "Validation" | "Review";
  stage: StageId;
};

const noWork = new Set([
  "present",
  "superseded",
  "intentional_divergence",
  "no_target_impact",
]);
const sectionFor: Record<StageId, NextStep["section"]> = {
  evidence: "Evidence",
  plan: "Plan",
  approve: "Plan",
  implement: "Changes",
  validate: "Validation",
  review: "Review",
};

function step(
  stage: StageId,
  title: string,
  detail: string,
  action: string,
): NextStep {
  return { title, detail, action, section: sectionFor[stage], stage };
}

export function canResolveNoAction(gap: Gap) {
  return (
    gap.requirements.length > 0 &&
    gap.requirements.every(
      (r) =>
        noWork.has(r.classification) &&
        !!r.rationale.trim() &&
        r.sourceEvidence.some((item) => item.trim()) &&
        r.targetEvidence.some((item) => item.trim()),
    ) &&
    (!gap.requirements.some(
      (r) => r.classification === "intentional_divergence",
    ) ||
      !!gap.intentionalDecision?.reason?.trim())
  );
}

export function canStartImplementation(
  gap: { status: string },
  run?: { stage: string; checks?: readonly unknown[] },
) {
  return (
    gap.status === "approved" ||
    (gap.status === "implementing" &&
      (run?.stage === "failed" || run?.stage === "interrupted") &&
      (run.checks?.length ?? 0) === 0)
  );
}

export function gapNextStep(gap: Gap, plan?: Plan, run?: Run): NextStep {
  if (gap.status === "integrated")
    return step(
      "review",
      "Integration confirmed",
      "This change is recorded on the target branch.",
      "View review",
    );
  if (gap.status === "resolved_no_action")
    return step(
      "evidence",
      "No target work required",
      "The decision and evidence are recorded. A changed scan can reopen it.",
      "View evidence",
    );
  if (gap.requirements.some((r) => r.classification === "needs_investigation"))
    return step(
      "evidence",
      "Investigate target behavior",
      "Compare source and target behavior, then record a classification and evidence for every requirement.",
      "Review evidence",
    );
  if (
    gap.requirements.some(
      (r) =>
        !r.rationale.trim() ||
        !r.sourceEvidence.some((item) => item.trim()) ||
        !r.targetEvidence.some((item) => item.trim()),
    )
  )
    return step(
      "evidence",
      "Complete the evidence",
      "Every requirement needs a reason plus source and target evidence before it can be resolved or approved.",
      "Edit evidence",
    );
  if (
    gap.requirements.some(
      (r) => r.classification === "intentional_divergence",
    ) &&
    !gap.intentionalDecision?.reason?.trim()
  )
    return step(
      "evidence",
      "Record the intentional difference",
      "Enter the decision maker and reason for preserving this target behavior.",
      "Edit evidence",
    );
  if (["open", "planned"].includes(gap.status) && canResolveNoAction(gap))
    return step(
      "evidence",
      "Record the no-work decision",
      "All requirements indicate no target implementation. Record who reviewed them and why.",
      "Resolve gap",
    );
  if (gap.status === "open" || !plan)
    return step(
      "plan",
      "Create an adaptation plan",
      "Describe the target behavior, exact files, and focused checks before requesting approval.",
      "Build plan",
    );
  if (gap.status === "planned")
    return unansweredPlanQuestions(plan.questions).length
      ? step(
          "plan",
          "Resolve plan questions",
          "Answer each open question, then save the revision.",
          "Edit plan",
        )
      : step(
          "approve",
          "Review and approve the plan",
          "Check the saved scope, behavior, and tests, then record your approval.",
          "Review plan",
        );
  if (gap.status === "approved")
    return step(
      "implement",
      "Implement in a worktree",
      "The approved plan is ready for the selected AI tool.",
      "Start implementation",
    );
  if (gap.status === "changes_requested")
    return step(
      "implement",
      "Address review findings",
      "Edit the retained worktree, then run validation again before another review.",
      "View changes",
    );
  if (
    gap.status === "implementing" &&
    (run?.stage === "failed" || run?.stage === "interrupted") &&
    run.checks.length === 0
  )
    return step(
      "implement",
      "Retry implementation",
      "The previous attempt stopped before validation. Start implementation again in the retained worktree.",
      "Retry implementation",
    );
  if (
    (run?.stage === "failed" || run?.stage === "interrupted") &&
    run.checks.length > 0
  )
    return step(
      "validate",
      "Rerun validation",
      "The edit is still in the worktree. A check failed, so run the checks again.",
      "Open validation",
    );
  if (run?.stage === "failed" || run?.stage === "interrupted")
    return step(
      "implement",
      "Inspect and recover the run",
      "The worktree is retained. Fix the issue and rerun validation when ready.",
      "View changes",
    );
  if (run?.stage === "validating") {
    const pipelineTestsFailed = run.checks.some(
      (check) =>
        check.name === "test" &&
        check.status === "failed" &&
        check.blocking === false,
    );
    return step(
      "validate",
      "Finish manual validation",
      pipelineTestsFailed
        ? "The production build passed. Pipeline tests are non-blocking, so record an observed outcome for each scenario."
        : "Record an observed outcome for each scenario. Failed checks must be fixed and rerun.",
      "Open validation",
    );
  }
  if (gap.status === "implementing")
    return run?.status === "Implementation finished; run validation"
      ? step(
          "validate",
          "Run required checks",
          "Validate the changed files, build, focused tests, and manual scenarios.",
          "Open validation",
        )
      : step(
          "implement",
          "Follow the implementation",
          "Activity shows the current action, any wait, and the outcome.",
          "View changes",
        );
  if (gap.status === "review_required")
    return step(
      "review",
      "Run independent review",
      "A fresh reviewer checks the diff against the plan and validation evidence.",
      "Open review",
    );
  if (gap.status === "verified_local")
    return step(
      "review",
      "Hand off and confirm integration",
      "Commit, push, and merge using Git, then record the integrated commit and evidence.",
      "Open handoff",
    );
  return step(
    "evidence",
    "Review this gap",
    "Inspect its evidence and current run status.",
    "View evidence",
  );
}

const stageOrder: { id: StageId; label: string; blocker: string }[] = [
  {
    id: "evidence",
    label: "Evidence",
    blocker: "Evidence stays available to inspect.",
  },
  {
    id: "plan",
    label: "Plan",
    blocker: "Finish source and target evidence before drafting a plan.",
  },
  {
    id: "approve",
    label: "Approve",
    blocker: "Save a plan revision before approval.",
  },
  {
    id: "implement",
    label: "Implement",
    blocker: "Approve the saved plan before implementation.",
  },
  {
    id: "validate",
    label: "Validate",
    blocker: "Finish implementation before validation.",
  },
  {
    id: "review",
    label: "Review",
    blocker: "Pass validation before review and handoff.",
  },
];

export function workflowStages(
  gap: Gap,
  plan?: Plan,
  run?: Run,
): WorkflowStage[] {
  const current = gapNextStep(gap, plan, run).stage;
  const currentIndex = stageOrder.findIndex((stage) => stage.id === current);
  return stageOrder.map((stage, index) => {
    if (stage.id === current) return { ...stage, state: "current", blocker: undefined };
    if (index < currentIndex)
      return { ...stage, state: "complete", blocker: undefined };
    if (stage.id === "evidence")
      return { ...stage, state: "available", blocker: undefined };
    if (stage.id === "validate" && run?.worktree)
      return { ...stage, state: "available", blocker: undefined };
    if (
      stage.id === "review" &&
      (run?.review ||
        gap.status === "verified_local" ||
        gap.status === "integrated")
    )
      return { ...stage, state: "available", blocker: undefined };
    return { ...stage, state: "blocked" };
  });
}

export function stageForGapStatus(status: string): StageId {
  switch (status) {
    case "planned":
      return "plan";
    case "approved":
    case "implementing":
    case "changes_requested":
      return "implement";
    case "review_required":
    case "verified_local":
    case "integrated":
      return "review";
    default:
      return "evidence";
  }
}

export function diffGroups(diff: string) {
  if (!diff.trim()) return [];
  const parts = diff.split(/\n(?=diff --git |Untracked (?:file|symlink): )/);
  const groups: { path: string; body: string }[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const renamed = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const untracked = part.match(/^Untracked (?:file|symlink): (.+)$/m);
    const path = (renamed?.[2] || untracked?.[1] || "").trim();
    groups.push({ path: path || "diff", body: part.trimEnd() });
  }
  return groups;
}

export function pairNextStep(pair: PairHealth) {
  if (!pair.bound)
    return {
      title: "Connect the repositories",
      detail: "Save the source and target checkout paths in Setup.",
      action: "Set up pair",
      href: "/setup",
    };
  if (!pair.snapshot)
    return {
      title: "Run the first analysis",
      detail: "Fetch source and target refs to discover integration events.",
      action: "Analyze pair",
      href: `/pairs/${pair.id}`,
    };
  if (pair.snapshot.events.length && !pair.snapshot.aiAssessedAt)
    return {
      title: "Complete the AI porting analysis",
      detail:
        "Compare source and target docs and code before reviewing decisions.",
      action: "Run analysis",
      href: `/pairs/${pair.id}`,
    };
  if (pair.snapshot.coverage.unprocessed.length)
    return {
      title: `${pair.investigations ?? pair.snapshot.coverage.unprocessed.length} decisions need investigation`,
      detail: pair.snapshot.aiAssessedAt
        ? "Open the porting decisions to see what remains uncertain."
        : "Run analysis so the AI tool can compare source and target behavior.",
      action: "View decisions",
      href: `/pairs/${pair.id}`,
    };
  if (pair.nextGap)
    return {
      title: "Continue the sync workflow",
      detail: pair.nextGap.title,
      action: "Continue gap",
      href: `/pairs/${pair.id}/gaps/${pair.nextGap.id}?stage=${stageForGapStatus(pair.nextGap.status)}`,
    };
  return {
    title: "All scanned changes reviewed",
    detail: "Run another analysis when the source branch advances.",
    action: "Open pair",
    href: `/pairs/${pair.id}`,
  };
}
