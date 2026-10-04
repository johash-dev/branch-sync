import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, isTerminal, providerLabel, statusLabel } from "./api.js";
import { validationSnapshot } from "./activity.js";
import {
  canResolveNoAction,
  canStartImplementation,
  diffGroups,
  gapNextStep,
  unansweredPlanQuestions,
  workflowStages,
  type StageId,
} from "./guidance.js";
import {
  EmptyState,
  ErrorMessage,
  Loading,
  useAction,
  useWorkspace,
} from "./AppShell.js";
import { ValidationProgressPanel } from "./JobCenter.js";
import type {
  Binding,
  Gap,
  Pair,
  Plan,
  Provider,
  Requirement,
  Run,
} from "./types.js";

type GapData = {
  gap: Gap;
  relatedGaps: { id: string; integrationSha: string; status: string }[];
  sourceRepository: string;
  sourceEvents: {
    sha: string;
    parent: string;
    subject: string;
    date: string;
    commits: { sha: string; subject: string; date: string }[];
    files: { status: string; path: string; previousPath?: string }[];
  }[];
  plan?: Plan;
  approval?: { approvedBy: string; approvedAt: string };
  run?: Run;
};
const stages: StageId[] = [
  "evidence",
  "plan",
  "approve",
  "implement",
  "validate",
  "review",
];
const reviewerKey = "branch-sync-reviewer";
const list = (value: string) => value.split("\n");
const clean = (value: string[]) =>
  value.map((item) => item.trim()).filter(Boolean);
const text = (value: string[]) => value.join("\n");
type DraftQuestion = { question: string; answer: string };
type PlanDraft = Omit<Plan, "questions"> & { questions: DraftQuestion[] };
const draftQuestions = (questions: Plan["questions"] = []): DraftQuestion[] =>
  questions.map((item) =>
    typeof item === "string"
      ? { question: item, answer: "" }
      : { question: item.question, answer: item.answer },
  );
const blankPlan = (): PlanDraft => ({
  sourceBehavior: "",
  targetBehavior: "",
  targetFiles: [],
  approach: "",
  conventions: [],
  dependencies: [],
  regressionTests: [],
  commands: [],
  manualScenarios: [],
  questions: [],
});
const planFields = (plan?: Plan): PlanDraft =>
  plan
    ? {
        sourceBehavior: plan.sourceBehavior,
        targetBehavior: plan.targetBehavior,
        targetFiles: plan.targetFiles,
        approach: plan.approach,
        conventions: plan.conventions,
        dependencies: plan.dependencies,
        regressionTests: plan.regressionTests,
        commands: plan.commands,
        manualScenarios: plan.manualScenarios,
        questions: draftQuestions(plan.questions),
      }
    : blankPlan();
const classifications = [
  "needs_investigation",
  "missing",
  "partial",
  "present",
  "no_target_impact",
  "superseded",
  "intentional_divergence",
];
const repositoryUrl = (value: string) => {
  const ssh = value.match(/^git@github\.com:([^\s]+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1].replace(/\.git$/, "")}`;
  return /^https:\/\//.test(value)
    ? value.replace(/\.git\/?$/, "").replace(/\/$/, "")
    : "";
};
const sourceUrl = (
  repository: string,
  kind: "commit" | "pr",
  value: string,
) => {
  const base = repositoryUrl(repository);
  if (!base) return "";
  if (kind === "commit") return `${base}/commit/${value}`;
  if (base.includes("dev.azure.com")) return `${base}/pullrequest/${value}`;
  if (base.includes("github.com")) return `${base}/pull/${value}`;
  return "";
};

function EvidenceSection({
  gap,
  base,
  act,
  busy,
  agentReady,
  reviewer,
  setReviewer,
  onDirty,
  primary,
  resolvePrimary,
}: {
  gap: Gap;
  base: string;
  act: (url: string, method?: string, body?: unknown) => Promise<any>;
  busy: boolean;
  agentReady: boolean;
  reviewer: string;
  setReviewer: (value: string) => void;
  onDirty: (dirty: boolean) => void;
  primary: boolean;
  resolvePrimary: boolean;
}) {
  const [requirements, setRequirements] = useState<Requirement[]>(
    gap.requirements,
  );
  const [decision, setDecision] = useState({
    reason: gap.intentionalDecision?.reason || "",
    decidedBy: gap.intentionalDecision?.decidedBy || "",
  });
  const [reason, setReason] = useState("");
  useEffect(() => {
    setRequirements(gap.requirements);
    setDecision({
      reason: gap.intentionalDecision?.reason || "",
      decidedBy: gap.intentionalDecision?.decidedBy || "",
    });
  }, [gap.updatedAt]);
  const change = (id: string, patch: Partial<Requirement>) =>
    setRequirements((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  const hasDifference = requirements.some(
    (item) => item.classification === "intentional_divergence",
  );
  const preview = {
    ...gap,
    requirements,
    intentionalDecision:
      hasDifference && decision.reason && decision.decidedBy
        ? { ...decision, at: new Date().toISOString() }
        : gap.intentionalDecision,
  };
  const dirty =
    JSON.stringify(requirements) !== JSON.stringify(gap.requirements) ||
    (hasDifference &&
      (decision.reason !== gap.intentionalDecision?.reason ||
        decision.decidedBy !== gap.intentionalDecision?.decidedBy));
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  return (
    <div className="section-panel">
      <div className="section-panel-head">
        <div>
          <h2>Understand the change</h2>
          <p>
            Classify each behavior using source and target evidence. Uncertain
            items stay open for investigation.
          </p>
        </div>
        <button
          disabled={busy || !agentReady}
          onClick={() => act(`${base}/assess`)}
        >
          Assess with AI tool
        </button>
      </div>
      {requirements.map((item, index) => (
        <article className="requirement-card" key={item.id}>
          <div className="requirement-heading">
            <span className="number-tag">{index + 1}</span>
            <h3>{item.behavior}</h3>
          </div>
          {item.impact && <p className="requirement-impact">{item.impact}</p>}
          <div className="form-grid">
            <label>
              Classification
              <select
                value={item.classification}
                onChange={(e) =>
                  change(item.id, { classification: e.target.value })
                }
              >
                {classifications.map((name) => (
                  <option key={name} value={name}>
                    {statusLabel(name)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Feature area
              <input
                value={item.featureArea}
                onChange={(e) =>
                  change(item.id, { featureArea: e.target.value })
                }
              />
            </label>
          </div>
          <label>
            Why this classification?
            <textarea
              rows={3}
              value={item.rationale}
              onChange={(e) => change(item.id, { rationale: e.target.value })}
              placeholder="Explain what the evidence shows"
              aria-invalid={!item.rationale.trim()}
            />
            {!item.rationale.trim() && (
              <p className="field-error">
                Add why this classification is correct, then save evidence.
              </p>
            )}
          </label>
          <div className="form-grid">
            <label>
              Source evidence{" "}
              <span className="field-hint">
                One file, line, or commit per line
              </span>
              <textarea
                rows={4}
                value={text(item.sourceEvidence)}
                onChange={(e) =>
                  change(item.id, { sourceEvidence: list(e.target.value) })
                }
                aria-invalid={!clean(item.sourceEvidence).length}
              />
              {!clean(item.sourceEvidence).length && (
                <p className="field-error">
                  Add at least one source file, line, or commit, then save
                  evidence.
                </p>
              )}
            </label>
            <label>
              Target evidence{" "}
              <span className="field-hint">
                One file, line, or ref per line
              </span>
              <textarea
                rows={4}
                value={text(item.targetEvidence)}
                onChange={(e) =>
                  change(item.id, { targetEvidence: list(e.target.value) })
                }
                aria-invalid={!clean(item.targetEvidence).length}
              />
              {!clean(item.targetEvidence).length && (
                <p className="field-error">
                  Add at least one target file, line, or ref, then save
                  evidence.
                </p>
              )}
            </label>
          </div>
        </article>
      ))}
      {hasDifference && (
        <div className="sub-panel">
          <h3>Intentional difference decision</h3>
          <p>Record who decided to preserve a difference and why.</p>
          <div className="form-grid">
            <label>
              Your name
              <input
                value={decision.decidedBy}
                onChange={(e) =>
                  setDecision({ ...decision, decidedBy: e.target.value })
                }
              />
            </label>
            <label>
              Reason
              <input
                value={decision.reason}
                onChange={(e) =>
                  setDecision({ ...decision, reason: e.target.value })
                }
                aria-invalid={!decision.reason.trim() || !decision.decidedBy.trim()}
              />
            </label>
          </div>
          {(!decision.decidedBy.trim() || !decision.reason.trim()) && (
            <p className="field-error">
              Enter your name and the reason for preserving this difference,
              then save evidence.
            </p>
          )}
        </div>
      )}
      <div className="button-row">
        <button
          className={primary && !resolvePrimary ? "primary" : undefined}
          disabled={
            busy ||
            !dirty ||
            (hasDifference &&
              (!decision.reason.trim() || !decision.decidedBy.trim()))
          }
          aria-busy={busy}
          onClick={() =>
            act(base, "PUT", {
              requirements: requirements.map((item) => ({
                ...item,
                sourceEvidence: clean(item.sourceEvidence),
                targetEvidence: clean(item.targetEvidence),
              })),
              ...(hasDifference
                ? {
                    intentionalDecision: {
                      decidedBy: decision.decidedBy.trim(),
                      reason: decision.reason.trim(),
                    },
                  }
                : {}),
            })
          }
        >
          {busy ? "Saving evidence…" : "Save evidence"}
        </button>
        {dirty && (
          <span className="unsaved">Unsaved changes. Save these edits before moving to another step.</span>
        )}
      </div>
      {gap.status === "resolved_no_action" && (
        <div className="setup-note success">
          <strong>No target work required.</strong> Reviewed by{" "}
          {gap.noActionResolution?.decidedBy}: {gap.noActionResolution?.reason}
        </div>
      )}
      {["open", "planned"].includes(gap.status) &&
        canResolveNoAction(preview) && (
          <div className="resolution-card">
            <span className="eyebrow">NO TARGET IMPLEMENTATION</span>
            <h3>Resolve with recorded evidence</h3>
            <p>
              Every requirement is classified as already present, superseded,
              intentionally different, or having no target impact. Save any
              edits above, then record the review decision.
            </p>
            <div className="form-grid">
              <label>
                Your name
                <input
                  value={reviewer}
                  onChange={(e) => setReviewer(e.target.value)}
                />
              </label>
              <label>
                Reason
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why no target work is needed"
                />
              </label>
            </div>
            <button
              className={resolvePrimary ? "primary" : undefined}
              disabled={busy || dirty || !reviewer.trim() || !reason.trim()}
              aria-busy={busy}
              onClick={() =>
                act(`${base}/resolve-no-action`, "POST", {
                  decidedBy: reviewer,
                  reason,
                })
              }
            >
              {busy ? "Recording decision…" : "Resolve: no target work"}
            </button>
            {dirty && (
              <p className="field-error">
                Save evidence first, then record who reviewed this and why.
              </p>
            )}
            {(!reviewer.trim() || !reason.trim()) && (
              <p className="field-error">
                Enter your name and why no target work is needed, then record
                the decision.
              </p>
            )}
          </div>
        )}
    </div>
  );
}

function PlanSection({
  data,
  base,
  act,
  busy,
  agentReady,
  onDirty,
  primary,
}: {
  data: GapData;
  base: string;
  act: (url: string, method?: string, body?: unknown) => Promise<any>;
  busy: boolean;
  agentReady: boolean;
  onDirty: (dirty: boolean) => void;
  primary: boolean;
}) {
  const [draft, setDraft] = useState<PlanDraft>(planFields(data.plan));
  useEffect(() => setDraft(planFields(data.plan)), [data.plan?.id]);
  const update = (patch: Partial<PlanDraft>) =>
    setDraft((value) => ({ ...value, ...patch }));
  const valid =
    !!draft.sourceBehavior.trim() &&
    !!draft.targetBehavior.trim() &&
    !!draft.approach.trim() &&
    clean(draft.targetFiles).length > 0 &&
    clean(draft.regressionTests).length > 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(planFields(data.plan));
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  return (
    <div className="section-panel">
      <div className="section-panel-head">
        <div>
          <h2>Plan the adaptation</h2>
          <p>
            Give the implementer exact target files, intended behavior, and
            checks. Approval locks this revision to the current refs.
          </p>
        </div>
        <button
          disabled={busy || !agentReady}
          onClick={() => act(`${base}/generate-plan`)}
        >
          Generate with AI tool
        </button>
      </div>
      <section className="plan-group">
        <h3>Behavior</h3>
        <div className="form-grid">
          <label>
            Source behavior
            <textarea
              rows={4}
              value={draft.sourceBehavior}
              onChange={(e) => update({ sourceBehavior: e.target.value })}
              placeholder="What the source change does"
              aria-invalid={!draft.sourceBehavior.trim()}
            />
            {!draft.sourceBehavior.trim() && (
              <p className="field-error">
                Describe what the source change does, then save the revision.
              </p>
            )}
          </label>
          <label>
            Target behavior
            <textarea
              rows={4}
              value={draft.targetBehavior}
              onChange={(e) => update({ targetBehavior: e.target.value })}
              placeholder="What should happen in the target"
              aria-invalid={!draft.targetBehavior.trim()}
            />
            {!draft.targetBehavior.trim() && (
              <p className="field-error">
                Describe the target behavior, then save the revision.
              </p>
            )}
          </label>
        </div>
        <label>
          Implementation approach
          <textarea
            rows={5}
            value={draft.approach}
            onChange={(e) => update({ approach: e.target.value })}
            placeholder="How the target should be adapted"
            aria-invalid={!draft.approach.trim()}
          />
          {!draft.approach.trim() && (
            <p className="field-error">
              Describe how the target should be adapted, then save the revision.
            </p>
          )}
        </label>
      </section>
      <section className="plan-group">
        <h3>Scope</h3>
        <label>
          Exact target files{" "}
          <span className="field-hint">
            One repository-relative path per line
          </span>
          <textarea
            rows={5}
            value={text(draft.targetFiles)}
            onChange={(e) => update({ targetFiles: list(e.target.value) })}
            aria-invalid={!clean(draft.targetFiles).length}
          />
          {!clean(draft.targetFiles).length && (
            <p className="field-error">
              Add at least one repository-relative path, then save the revision.
            </p>
          )}
        </label>
        <details>
          <summary>Conventions and dependencies</summary>
          <div className="form-grid">
            <label>
              Target conventions
              <textarea
                rows={4}
                value={text(draft.conventions)}
                onChange={(e) => update({ conventions: list(e.target.value) })}
              />
            </label>
            <label>
              Dependencies <span className="field-hint">Gap IDs, one per line</span>
              <textarea
                rows={4}
                value={text(draft.dependencies)}
                onChange={(e) => update({ dependencies: list(e.target.value) })}
              />
            </label>
          </div>
        </details>
      </section>
      <section className="plan-group">
        <h3>Verification</h3>
        <div className="form-grid">
          <label>
            Regression tests{" "}
            <span className="field-hint">One focused test per line</span>
            <textarea
              rows={5}
              value={text(draft.regressionTests)}
              onChange={(e) => update({ regressionTests: list(e.target.value) })}
              aria-invalid={!clean(draft.regressionTests).length}
            />
            {!clean(draft.regressionTests).length && (
              <p className="field-error">
                Add at least one focused test, then save the revision.
              </p>
            )}
          </label>
          <label>
            Manual scenarios
            <textarea
              rows={4}
              value={text(draft.manualScenarios)}
              onChange={(e) => update({ manualScenarios: list(e.target.value) })}
            />
          </label>
        </div>
        <details>
          <summary>Additional test commands</summary>
          <div className="subsection-heading">
            <p className="muted small">
              The pair&apos;s required build and test commands also run during
              validation.
            </p>
            <button
              onClick={() =>
                update({
                  commands: [...draft.commands, { executable: "", args: [] }],
                })
              }
            >
              Add command
            </button>
          </div>
          {draft.commands.map((command, index) => (
            <div className="mapping-row command-line" key={index}>
              <input
                aria-label={`Command ${index + 1} executable`}
                placeholder="Executable"
                value={command.executable}
                onChange={(e) =>
                  update({
                    commands: draft.commands.map((item, i) =>
                      i === index ? { ...item, executable: e.target.value } : item,
                    ),
                  })
                }
              />
              <input
                aria-label={`Command ${index + 1} arguments`}
                placeholder="Arguments, one per line separated by |"
                value={command.args.join(" | ")}
                onChange={(e) =>
                  update({
                    commands: draft.commands.map((item, i) =>
                      i === index
                        ? {
                            ...item,
                            args: e.target.value
                              .split("|")
                              .map((x) => x.trim())
                              .filter(Boolean),
                          }
                        : item,
                    ),
                  })
                }
              />
              <button
                className="icon-button"
                aria-label={`Remove command ${index + 1}`}
                onClick={() =>
                  update({
                    commands: draft.commands.filter((_, i) => i !== index),
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
        </details>
      </section>
      <section className="plan-group">
        <div className="subsection-heading">
          <h3>Questions</h3>
        <button
          onClick={() =>
            update({
              questions: [...draft.questions, { question: "", answer: "" }],
            })
          }
        >
          Add question
        </button>
      </div>
      <p className="muted small">
        {draft.questions.length
          ? "Answer each question, then save the revision. A blank answer blocks approval."
          : "No open questions."}
      </p>
      {draft.questions.map((item, index) => {
        const answered = !!item.question.trim() && !!item.answer.trim();
        return (
          <div className="question-row" key={index}>
            <div className="question-row-head">
              <span className="number-tag">{index + 1}</span>
              <span className={`status-pill ${answered ? "ready" : "warning"}`}>
                {answered ? "Answered" : "Needs answer"}
              </span>
              <button
                className="icon-button"
                aria-label={`Remove question ${index + 1}`}
                onClick={() =>
                  update({
                    questions: draft.questions.filter((_, i) => i !== index),
                  })
                }
              >
                ×
              </button>
            </div>
            <label>
              Question {index + 1}
              <textarea
                rows={3}
                value={item.question}
                onChange={(e) =>
                  update({
                    questions: draft.questions.map((entry, i) =>
                      i === index
                        ? { ...entry, question: e.target.value }
                        : entry,
                    ),
                  })
                }
              />
            </label>
            <label>
              Answer {index + 1}
              <textarea
                rows={2}
                value={item.answer}
                placeholder="Decision the plan should follow"
                aria-invalid={!item.answer.trim()}
                aria-describedby={
                  !item.answer.trim() ? `answer-error-${index}` : undefined
                }
                onChange={(e) =>
                  update({
                    questions: draft.questions.map((entry, i) =>
                      i === index
                        ? { ...entry, answer: e.target.value }
                        : entry,
                    ),
                  })
                }
              />
            </label>
            {!item.answer.trim() && (
              <p className="field-error" id={`answer-error-${index}`}>
                Answer this question, then save the revision before approval.
              </p>
            )}
          </div>
        );
      })}
      </section>
      <div className="button-row">
        <button
          className={primary ? "primary" : undefined}
          disabled={busy || !valid}
          aria-busy={busy}
          onClick={() =>
            act(`${base}/plan`, "POST", {
              ...draft,
              targetFiles: clean(draft.targetFiles),
              conventions: clean(draft.conventions),
              dependencies: clean(draft.dependencies),
              regressionTests: clean(draft.regressionTests),
              manualScenarios: clean(draft.manualScenarios),
              questions: draft.questions
                .map((item) => ({
                  question: item.question.trim(),
                  answer: item.answer.trim(),
                }))
                .filter((item) => item.question),
            })
          }
        >
          {busy ? "Saving plan…" : "Save plan revision"}
        </button>
        {dirty && <span className="unsaved">Unsaved changes</span>}
        <span className="muted small">
          {data.plan?.id
            ? dirty
              ? "Save your edits before approval."
              : unansweredPlanQuestions(data.plan.questions).length
                ? "Answer every open question, then save, before approval."
                : "A saved revision is ready for review."
            : "Save a revision before approval."}
        </span>
      </div>
    </div>
  );
}

function ChangesSection({
  data,
  diff,
  base,
  act,
  busy,
  agentReady,
  onActivity,
  primary,
}: {
  data: GapData;
  diff?: string;
  base: string;
  act: (url: string, method?: string, body?: unknown) => Promise<any>;
  busy: boolean;
  agentReady: boolean;
  onActivity: () => void;
  primary: boolean;
}) {
  const validationFailed =
    data.gap.status === "implementing" &&
    !!data.run &&
    (data.run.stage === "failed" || data.run.stage === "interrupted") &&
    data.run.checks.length > 0;
  return (
    <div className="section-panel">
      <div className="section-panel-head">
        <div>
          <h2>Implementation & diff</h2>
          <p>
            The AI tool works in a dedicated target worktree and stays within
            the approved file list.
          </p>
        </div>
        <button
          className={primary ? "primary" : undefined}
          disabled={
            busy ||
            (validationFailed
              ? false
              : !agentReady || !canStartImplementation(data.gap, data.run))
          }
          aria-busy={busy}
          onClick={() =>
            act(validationFailed ? `${base}/validate` : `${base}/implement`)
          }
        >
          {busy
            ? "Starting…"
            : validationFailed
              ? "Run checks again"
              : data.gap.status === "implementing"
                ? "Retry implementation"
                : "Implement in worktree"}
        </button>
      </div>
      {data.gap.status !== "approved" && !data.run && (
        <div className="setup-note warning">
          Approve a complete plan before implementation can start.
        </div>
      )}
      {data.gap.status === "implementing" &&
        canStartImplementation(data.gap, data.run) && (
          <div className="setup-note warning">
            The last attempt stopped before validation. Retry implementation to
            continue in this worktree.
          </div>
        )}
      {validationFailed && (
        <div className="setup-note warning">
          A check failed after the edit was made. Run the checks again. This
          worktree already has the edit.
        </div>
      )}
      {data.run && (
        <div className="run-summary">
          <div>
            <span>Worktree</span>
            <code>{data.run.worktree}</code>
          </div>
          <div>
            <span>Branch</span>
            <code>{data.run.branch}</code>
          </div>
          <div>
            <span>State</span>
            <strong>{data.run.status}</strong>
          </div>
        </div>
      )}
      {data.run && (
        <div className="button-row">
          <button type="button" onClick={onActivity}>
            Open Activity
          </button>
          {(data.run.stage === "failed" || data.run.stage === "interrupted") && (
            <p className="field-hint">
              Retry reason: {data.run.status}. The worktree is retained.
            </p>
          )}
        </div>
      )}
      {data.gap.status === "changes_requested" && (
        <div className="setup-note warning">
          Review requested changes. Edit the retained worktree, then run
          validation again from the Validation step.
        </div>
      )}
      <div className="scope-layout">
        <div>
          <h3>Approved scope</h3>
          {data.plan?.targetFiles.length ? (
            <ul className="path-list">
              {data.plan.targetFiles.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No approved files yet.</p>
          )}
        </div>
        <div>
          <h3>Changed files</h3>
          {diffGroups(diff || "").length ? (
            <ul className="path-list">
              {diffGroups(diff || "").map((file) => {
                const allowed = new Set(
                  (data.plan?.targetFiles || []).map((item) =>
                    item.replace(/\\/g, "/"),
                  ),
                );
                const outside = !allowed.has(file.path.replace(/\\/g, "/"));
                return (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    {outside && (
                      <span className="status-pill warning">
                        Outside approved scope
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted small">No changed files yet.</p>
          )}
        </div>
      </div>
      {diffGroups(diff || "").some(
        (file) =>
          !(data.plan?.targetFiles || [])
            .map((item) => item.replace(/\\/g, "/"))
            .includes(file.path.replace(/\\/g, "/")),
      ) && (
        <p className="setup-note warning">
          Some changed files are outside the approved scope. Revise and approve
          the plan before validation can accept them.
        </p>
      )}
      <div className="subsection-heading">
        <h3>Complete diff</h3>
        <span className="muted small">Grouped by file. The raw diff stays available from the workbench.</span>
      </div>
      {data.run ? (
        diffGroups(diff || "").length ? (
          diffGroups(diff || "").map((file) => (
            <details key={file.path} className="diff-file" open>
              <summary>
                <code>{file.path}</code>
              </summary>
              <pre className="diff-view">{file.body}</pre>
            </details>
          ))
        ) : (
          <pre className="diff-view">No changes in this worktree yet.</pre>
        )
      ) : (
        <EmptyState title="No worktree yet">
          Start implementation after approving the plan. The full diff will
          appear here.
        </EmptyState>
      )}
    </div>
  );
}

function ValidationSection({
  data,
  base,
  act,
  busy,
  pairId,
  gapId,
  primary,
}: {
  data: GapData;
  base: string;
  act: (url: string, method?: string, body?: unknown) => Promise<any>;
  busy: boolean;
  pairId: string;
  gapId: string;
  primary: boolean;
}) {
  const { jobs } = useWorkspace();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const focusRef = useRef<HTMLInputElement>(null);
  const job = jobs.find(
    (item) =>
      item.kind === "validate" &&
      item.pairId === pairId &&
      item.gapId === gapId &&
      !isTerminal(item.status),
  );
  const live = job ? validationSnapshot(job.events) : undefined;
  const firstPending = data.run?.manualResults.find(
    (item) => item.status !== "passed",
  );
  useEffect(() => {
    focusRef.current?.focus();
  }, [firstPending?.scenario]);
  const checkState = (name: string, index: number) => {
    const current = live?.progress;
    if (current && current.name === name && current.index === index)
      return current.phase;
    const saved = data.run?.checks[index];
    if (saved?.name === name) {
      if (saved.status === "failed" && saved.blocking === false)
        return "non-blocking";
      return saved.status;
    }
    return "pending";
  };
  return (
    <div className="section-panel">
      <div className="section-panel-head">
        <div>
          <h2>Validate the work</h2>
          <p>
            Install and the production build must pass. When the target
            pipeline marks tests as non-blocking, a failing test does not stop
            you after that build succeeds. Record what you observed for each
            manual scenario.
          </p>
        </div>
        <button
          className={primary ? "primary" : undefined}
          disabled={busy || !data.run}
          aria-busy={busy}
          onClick={() => act(`${base}/validate`)}
        >
          {busy ? "Starting checks…" : "Run required checks"}
        </button>
      </div>
      {!data.run && (
        <div className="setup-note warning">
          Implementation creates the worktree needed for validation.
        </div>
      )}
      {live?.progress && (
        <ValidationProgressPanel
          progress={live.progress}
          runningSince={live.runningSince}
          lastOutputAt={live.lastOutputAt}
          connection="connected"
          status={job?.status}
          error={job?.error}
        />
      )}
      <div className="check-list">
        <h3>Checks and scenarios</h3>
        {(data.run?.checks.length ? data.run.checks : []).map((check, index) => {
          const state = checkState(check.name, index);
          const label =
            state === "passed" || state === "reused"
              ? "passed"
              : state === "running"
                ? "running"
                : state === "non-blocking"
                  ? "non-blocking"
                  : state === "failed"
                    ? "failed"
                    : "pending";
          return (
            <details className="check-row" key={`${check.name}-${index}`}>
              <summary>
                <span className={`check-mark ${label}`} aria-hidden="true">
                  {label === "passed" ? "✓" : label === "running" ? "…" : "!"}
                </span>
                <strong>{check.name}</strong>
                <span className={`status-pill ${label === "passed" ? "ready" : label === "pending" || label === "running" ? "neutral" : "warning"}`}>
                  {label}
                </span>
              </summary>
              <pre>{check.output}</pre>
            </details>
          );
        })}
        {!data.run?.checks.length && !live?.progress && data.run && (
          <p className="muted">No automated checks recorded yet. They appear here as pending, running, passed, failed, or non-blocking.</p>
        )}
      </div>
      {!!data.run?.manualResults.length && (
        <div className="manual-list">
          <h3>Manual scenarios</h3>
          {data.run.manualResults.map((item) => (
            <div className="manual-item" key={item.scenario}>
              <div>
                <strong>{item.scenario}</strong>
                <span
                  className={`status-pill ${item.status === "passed" ? "ready" : item.status === "failed" ? "warning" : "neutral"}`}
                >
                  {item.status}
                </span>
              </div>
              <p>
                {item.notes ||
                  "Record the observed result after testing this scenario."}
              </p>
              <label>
                What did you observe?
                <input
                  ref={item.scenario === firstPending?.scenario ? focusRef : undefined}
                  value={notes[item.scenario] || item.notes || ""}
                  onChange={(e) =>
                    setNotes({ ...notes, [item.scenario]: e.target.value })
                  }
                  placeholder="Describe the observed behavior"
                  aria-invalid={
                    data.run?.stage === "validating" &&
                    !(notes[item.scenario] || item.notes)?.trim()
                  }
                />
              </label>
              {data.run?.stage === "validating" &&
                item.status === "pending" &&
                !(notes[item.scenario] || item.notes)?.trim() && (
                  <p className="field-hint" id={`${item.scenario}-notes`}>
                    Enter what you observed, then mark this scenario passed or failed.
                  </p>
                )}
              <div className="button-row">
                <button
                  disabled={
                    busy ||
                    data.run?.stage !== "validating" ||
                    !notes[item.scenario]?.trim()
                  }
                  onClick={() =>
                    act(`${base}/manual`, "POST", {
                      scenario: item.scenario,
                      status: "passed",
                      notes: notes[item.scenario],
                    })
                  }
                >
                  Pass
                </button>
                <button
                  disabled={
                    busy ||
                    data.run?.stage !== "validating" ||
                    !notes[item.scenario]?.trim()
                  }
                  onClick={() =>
                    act(`${base}/manual`, "POST", {
                      scenario: item.scenario,
                      status: "failed",
                      notes: notes[item.scenario],
                    })
                  }
                >
                  Fail
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewSection({
  data,
  base,
  act,
  busy,
  agentReady,
  primary,
}: {
  data: GapData;
  base: string;
  act: (url: string, method?: string, body?: unknown) => Promise<any>;
  busy: boolean;
  agentReady: boolean;
  primary: boolean;
}) {
  const [sha, setSha] = useState("");
  const [evidence, setEvidence] = useState("");
  return (
    <div className="section-panel">
      <div className="section-panel-head">
        <div>
          <h2>Review and handoff</h2>
          <p>
            Independent review, Git handoff, and integration confirmation are
            separate steps. Commit, push, and merge stay in Git.
          </p>
        </div>
        <button
          className={
            primary && data.gap.status !== "verified_local" ? "primary" : undefined
          }
          disabled={
            busy || !agentReady || data.gap.status !== "review_required"
          }
          aria-busy={busy}
          onClick={() => act(`${base}/review`)}
        >
          {busy ? "Starting review…" : "Run independent review"}
        </button>
      </div>
      {data.gap.status !== "review_required" && !data.run?.review && (
        <div className="setup-note warning">
          Validation must pass before independent review can start.
        </div>
      )}
      {data.run?.review && (
        <div
          className={`setup-note ${data.run.review.verdict === "approved" ? "success" : "warning"}`}
        >
          <strong>
            {data.run.review.verdict === "approved"
              ? "Review approved"
              : "Changes requested"}
          </strong>
          <span> · {new Date(data.run.review.at).toLocaleString()}</span>
          {data.run.review.findings.length > 0 && (
            <ul>
              {data.run.review.findings.map((finding, index) => (
                <li key={index}>{finding}</li>
              ))}
            </ul>
          )}
          <p className="muted small">
            Compare the findings with the{" "}
            <Link to={`${base}?stage=plan`}>saved plan</Link>,{" "}
            <Link to={`${base}?stage=implement`}>diff</Link>, and{" "}
            <Link to={`${base}?stage=validate`}>validation evidence</Link>.
          </p>
        </div>
      )}
      {data.gap.status === "verified_local" && data.run && (
        <div className="handoff-card">
          <span className="eyebrow">GIT HANDOFF READY</span>
          <h3>Commit, push, and merge</h3>
          <p>
            Review the complete diff in Changes, then use your usual Git tools
            to deliver this branch.
          </p>
          <div className="run-summary">
            <div>
              <span>Worktree</span>
              <code>{data.run.worktree}</code>
            </div>
            <div>
              <span>Branch</span>
              <code>{data.run.branch}</code>
            </div>
            <div>
              <span>Suggested commit</span>
              <code>
                Adapt {data.gap.sourceSubject} for {data.gap.pairId}
              </code>
            </div>
          </div>
        </div>
      )}
      <div className="integration-form">
        <h3>Confirm integration</h3>
        <p>
          After merging, enter the commit now reachable from the target ref and
          evidence that it was verified.
        </p>
        <div className="form-grid">
          <label>
            Integrated commit SHA
            <input
              className="mono"
              value={sha}
              onChange={(e) => setSha(e.target.value)}
              placeholder="40-character Git commit"
              aria-invalid={!!sha && !/^[0-9a-f]{40}$/i.test(sha)}
            />
            {!!sha && !/^[0-9a-f]{40}$/i.test(sha) && (
              <p className="field-error">
                Enter the full 40-character commit that is reachable from the
                target ref, then confirm integration.
              </p>
            )}
          </label>
          <label>
            Verification evidence
            <input
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="What did you verify?"
            />
          </label>
        </div>
        <button
          className={
            primary && data.gap.status === "verified_local" ? "primary" : undefined
          }
          disabled={
            busy ||
            data.gap.status !== "verified_local" ||
            !/^[0-9a-f]{40}$/i.test(sha) ||
            !evidence.trim()
          }
          onClick={() =>
            act(`${base}/integrate`, "POST", {
              integratedSha: sha,
              evidence: [evidence],
            })
          }
        >
          Confirm integration
        </button>
        {data.gap.status !== "verified_local" && (
          <p className="field-hint">
            Independent review must approve the validated changes first.
          </p>
        )}
      </div>
    </div>
  );
}

function ApproveSection({
  data,
  base,
  act,
  busy,
  identity,
  setIdentity,
  primary,
}: {
  data: GapData;
  base: string;
  act: (url: string, method?: string, body?: unknown) => Promise<any>;
  busy: boolean;
  identity: string;
  setIdentity: (value: string) => void;
  primary: boolean;
}) {
  const plan = data.plan;
  const blockers = [
    !plan ? "Save a plan revision before approval." : "",
    plan && unansweredPlanQuestions(plan.questions).length
      ? "Answer every open question, then save, before approval."
      : "",
    data.gap.requirements.some((item) => item.classification === "needs_investigation")
      ? "Resolve uncertain classifications in Evidence before approval."
      : "",
    !identity.trim() ? "Enter your name to record who approved this revision." : "",
  ].filter(Boolean);
  return (
    <div className="section-panel">
      <div className="section-panel-head">
        <div>
          <h2>Approve the saved revision</h2>
          <p>
            This summary is the saved plan, not the unsaved draft. Approval
            locks that revision to the current refs and file scope.
          </p>
        </div>
      </div>
      {!plan && (
        <p className="setup-note warning">
          Save a plan revision before approval. Open Plan, complete the draft,
          and save it.
        </p>
      )}
      {plan && (
        <div className="saved-plan">
          <h3>Saved behavior</h3>
          <p>{plan.targetBehavior || plan.sourceBehavior}</p>
          <h3>Locked scope</h3>
          <ul className="path-list">
            {plan.targetFiles.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
          <h3>Verification</h3>
          <ul>
            {plan.regressionTests.map((test) => (
              <li key={test}>{test}</li>
            ))}
          </ul>
          {!!plan.questions.length && (
            <>
              <h3>Questions</h3>
              <ul>
                {plan.questions.map((item, index) => {
                  const question = typeof item === "string" ? item : item.question;
                  const answer = typeof item === "string" ? "" : item.answer;
                  return (
                    <li key={index}>
                      {question} — {answer.trim() || "Unanswered"}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {data.approval && (
            <p>
              Previously approved by {data.approval.approvedBy}. A new approval
              records the person named below.
            </p>
          )}
        </div>
      )}
      {!!blockers.length && (
        <ul className="blocker-list">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
      <div className="approval-box">
        <label>
          Your name
          <input
            value={identity}
            autoComplete="name"
            onChange={(event) => setIdentity(event.target.value)}
          />
        </label>
        <button
          className={primary ? "primary" : undefined}
          aria-busy={busy}
          disabled={busy || blockers.length > 0}
          onClick={() => act(`${base}/approve`, "POST", { approvedBy: identity.trim() })}
        >
          {busy ? "Recording approval…" : "Approve saved plan"}
        </button>
      </div>
    </div>
  );
}

export function GapPage() {
  const { id = "", gapId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const focus = searchParams.get("focus") || "";
  const { data, error, isLoading } = useQuery<GapData>({
    queryKey: ["gap", id, gapId, focus],
    queryFn: () =>
      api(
        `/pairs/${id}/gaps/${gapId}${focus ? `?focus=${encodeURIComponent(focus)}` : ""}`,
      ),
  });
  const { data: diff } = useQuery<{ diff: string }>({
    queryKey: ["diff", id, gapId],
    queryFn: () => api(`/pairs/${id}/gaps/${gapId}/diff`),
    enabled: !!data?.run,
  });
  const { data: setup } = useQuery<{ pairs: Pair[]; binding: Binding }>({
    queryKey: ["pairs"],
    queryFn: () => api("/pairs"),
  });
  const { data: providers } = useQuery<Provider[]>({
    queryKey: ["providers"],
    queryFn: () => api("/providers"),
  });
  const { act, error: actionError, busy } = useAction();
  const { openActivity, jobs } = useWorkspace();
  const [reviewer, setReviewerState] = useState(() => {
    try {
      return sessionStorage.getItem(reviewerKey) || "";
    } catch {
      return "";
    }
  });
  const setReviewer = (value: string) => {
    setReviewerState(value);
    try {
      sessionStorage.setItem(reviewerKey, value);
    } catch {}
  };
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const onDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);
  const gap = data?.gap;
  const displayRequirements =
    gap?.requirements.filter(
      (requirement) =>
        !focus || requirement.groupKey === focus || requirement.id === focus,
    ) || [];
  const shownRequirements = displayRequirements.length
    ? displayRequirements
    : gap?.requirements || [];
  const decisionLabel = shownRequirements.some((r) =>
    ["missing", "partial"].includes(r.classification),
  )
    ? "Port to target"
    : shownRequirements.some((r) => r.classification === "needs_investigation")
      ? "Investigate"
      : "No port needed";
  const next = gap && gapNextStep(gap, data?.plan, data?.run);
  const rail = gap ? workflowStages(gap, data?.plan, data?.run) : [];
  const requested = searchParams.get("stage");
  const stage: StageId =
    requested && stages.includes(requested as StageId)
      ? (requested as StageId)
      : next?.stage || "evidence";
  const seeded = useRef(false);
  useEffect(() => {
    if (!next || seeded.current) return;
    seeded.current = true;
    if (searchParams.get("stage")) return;
    const params = new URLSearchParams(searchParams);
    params.set("stage", next.stage);
    setSearchParams(params, { replace: true });
  }, [next, searchParams, setSearchParams]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest("a");
      if (!anchor || anchor.target === "_blank") return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (
        !window.confirm(
          "You have unsaved changes. Leave this page without saving?",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);
  const selectStage = (nextStage: StageId) => {
    if (
      dirtyRef.current &&
      nextStage !== stage &&
      !window.confirm(
        "You have unsaved changes. Leave this stage without saving?",
      )
    )
      return;
    const params = new URLSearchParams(searchParams);
    params.set("stage", nextStage);
    if (focus) params.set("focus", focus);
    setSearchParams(params);
  };
  const provider = setup?.binding.defaultProvider || "codex";
  const ready = !!providers?.find((item) => item.provider === provider)
    ?.available;
  const base = `/pairs/${id}/gaps/${gapId}`;
  const pairName = setup?.pairs.find((pair) => pair.id === id)?.name || id;
  const stripActs =
    !!next &&
    (next.action === "Start implementation" ||
      next.action === "Retry implementation") &&
    !!gap &&
    canStartImplementation(gap, data?.run);
  const stageIsPrimary =
    !!next && (dirty || (next.stage === stage && !stripActs));
  return (
    <div className="page gap-page">
      <header className="page-header gap-header">
        <div>
          <Link className="back-link" to={`/pairs/${id}`}>
            ← {pairName}
          </Link>
          <span className="eyebrow">PORTING DECISION</span>
          <h1>
            {shownRequirements[0]?.behavior ||
              gap?.sourceSubject ||
              "Change review"}
          </h1>
          <span
            className={`status-pill ${["integrated", "resolved_no_action", "verified_local"].includes(gap?.status || "") ? "ready" : "neutral"}`}
          >
            {gap?.status === "open"
              ? decisionLabel
              : statusLabel(gap?.status || "Loading")}
          </span>
        </div>
      </header>
      {isLoading && <Loading />}
      <ErrorMessage message={error ? String(error) : actionError} />
      {providers && setup && !ready && (
        <div className="message warning-message">
          <strong>{providerLabel(provider)} needs setup</strong>
          <span>
            Agent-assisted actions need its CLI installed and signed in on this
            machine. <Link to="/settings">Change or check AI tool →</Link>
          </span>
        </div>
      )}
      {gap && next && (
        <>
          <section className="next-card">
            <div className="next-symbol">→</div>
            <div>
              <span className="eyebrow">NEXT ACTION</span>
              <h2>{next.title}</h2>
              <p>{next.detail}</p>
            </div>
            <button
              className={stageIsPrimary ? undefined : "primary"}
              aria-busy={busy}
              disabled={
                (next.action === "Start implementation" ||
                  next.action === "Retry implementation") &&
                (busy || !ready)
              }
              onClick={() => {
                if (
                  (next.action === "Start implementation" ||
                    next.action === "Retry implementation") &&
                  canStartImplementation(gap, data?.run)
                ) {
                  selectStage("implement");
                  void act(`${base}/implement`);
                  return;
                }
                selectStage(next.stage);
              }}
            >
              {busy ? "Working…" : `${next.action} →`}
            </button>
          </section>
          <nav className="stage-rail" aria-label="Workflow stages">
            {rail.map((item, index) => (
              <button
                key={item.id}
                className={stage === item.id ? "active" : ""}
                aria-current={item.state === "current" ? "step" : undefined}
                onClick={() => selectStage(item.id)}
              >
                <span className="stage-number">{index + 1}</span>{" "}
                <span>{item.label}</span>{" "}
                <span className={`stage-state ${item.state}`}>{item.state}</span>
              </button>
            ))}
          </nav>
          {stage !== "evidence" && rail.find((item) => item.id === stage)?.blocker && (
            <p className="stage-blocker">
              {rail.find((item) => item.id === stage)?.blocker}
            </p>
          )}
          {stage === "evidence" && (
            <EvidenceSection
              gap={gap}
              base={base}
              act={act}
              busy={busy}
              agentReady={ready}
              reviewer={reviewer}
              setReviewer={setReviewer}
              onDirty={onDirty}
              primary={stageIsPrimary}
              resolvePrimary={
                stageIsPrimary && next.action === "Resolve gap" && !dirty
              }
            />
          )}
          {stage === "evidence" && (
          <section className="source-context">
            <details className="source-history">
              <summary>
                Related PRs, commits, and changed files (
                {data?.sourceEvents.length || 0})
              </summary>
              {data?.sourceEvents.map((event) => (
                <div className="source-event" key={event.sha}>
                  <strong>{event.subject}</strong>
                  {(() => {
                    const pr = event.subject.match(
                      /\b(?:PR\s*#?|pull request\s*#?)(\d+)/i,
                    )?.[1];
                    const url =
                      pr && sourceUrl(data.sourceRepository, "pr", pr);
                    return (
                      pr && (
                        <div className="muted small">
                          PR{" "}
                          {url ? (
                            <a href={url} target="_blank" rel="noreferrer">
                              #{pr} ↗
                            </a>
                          ) : (
                            `#${pr}`
                          )}
                        </div>
                      )
                    );
                  })()}
                  <div className="muted small">
                    Integration commit{" "}
                    {sourceUrl(data.sourceRepository, "commit", event.sha) ? (
                      <a
                        href={sourceUrl(
                          data.sourceRepository,
                          "commit",
                          event.sha,
                        )}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <code>{event.sha.slice(0, 12)}</code> ↗
                      </a>
                    ) : (
                      <code>{event.sha}</code>
                    )}{" "}
                    · {new Date(event.date).toLocaleString()}
                  </div>
                  {!!event.commits.length && (
                    <ul className="source-commits">
                      {event.commits.map((commit) => (
                        <li key={commit.sha}>
                          {sourceUrl(
                            data.sourceRepository,
                            "commit",
                            commit.sha,
                          ) ? (
                            <a
                              href={sourceUrl(
                                data.sourceRepository,
                                "commit",
                                commit.sha,
                              )}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <code>{commit.sha.slice(0, 10)}</code> ↗
                            </a>
                          ) : (
                            <code>{commit.sha.slice(0, 10)}</code>
                          )}{" "}
                          {commit.subject}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="muted small">
                    Files:{" "}
                    {event.files.map((file) => file.path).join(", ") || "None"}
                  </div>
                </div>
              ))}
            </details>
            {(data?.relatedGaps.length || 0) > 1 && (
              <div className="related-records">
                <strong>Source records covered by this decision</strong>
                <p className="muted small">
                  Each record keeps its own implementation status.
                </p>
                {data?.relatedGaps.map((record) => (
                  <Link key={record.id} to={`/pairs/${id}/gaps/${record.id}`}>
                    {record.integrationSha.slice(0, 10)} ·{" "}
                    {statusLabel(record.status)} →
                  </Link>
                ))}
              </div>
            )}
            {focus && gap.requirements.length > shownRequirements.length && (
              <Link
                className="other-behaviors"
                to={`/pairs/${id}/gaps/${gapId}`}
              >
                View the other behaviors from this source event →
              </Link>
            )}
          </section>
          )}
          {stage === "plan" && (
            <PlanSection
              data={data!}
              base={base}
              act={act}
              busy={busy}
              agentReady={ready}
              onDirty={onDirty}
              primary={stageIsPrimary}
            />
          )}
          {stage === "approve" && (
            <ApproveSection
              data={data!}
              base={base}
              act={act}
              busy={busy}
              identity={reviewer}
              setIdentity={setReviewer}
              primary={stageIsPrimary}
            />
          )}
          {stage === "implement" && (
            <ChangesSection
              data={data!}
              diff={diff?.diff}
              base={base}
              act={act}
              busy={busy}
              agentReady={ready}
              primary={stageIsPrimary}
              onActivity={() =>
                openActivity(
                  jobs.find(
                    (job) =>
                      job.gapId === gapId &&
                      !isTerminal(job.status) &&
                      job.kind === "implement",
                  )?.id,
                )
              }
            />
          )}
          {stage === "validate" && (
            <ValidationSection
              data={data!}
              base={base}
              act={act}
              busy={busy}
              pairId={id}
              gapId={gapId}
              primary={stageIsPrimary}
            />
          )}
          {stage === "review" && (
            <ReviewSection
              data={data!}
              base={base}
              act={act}
              busy={busy}
              agentReady={ready}
              primary={stageIsPrimary}
            />
          )}
        </>
      )}
    </div>
  );
}
