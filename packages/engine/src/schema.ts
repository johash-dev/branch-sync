import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const command = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
});
export const pairConfigSchema = z.object({
  version: z.literal(1),
  id,
  name: z.string().min(1),
  source: z.object({
    remote: z.string().min(1),
    identity: z.string().default(""),
    ref: z.string().min(1),
  }),
  target: z.object({
    remote: z.string().min(1),
    identity: z.string().default(""),
    ref: z.string().min(1),
  }),
  baseline: sha,
  rules: z.array(z.string()).default([]),
  mappings: z
    .array(
      z.object({
        source: z.string().min(1),
        target: z.string().min(1),
        note: z.string().default(""),
      }),
    )
    .default([]),
  intentionalDifferences: z
    .array(
      z.object({
        behavior: z.string(),
        reason: z.string(),
        decidedBy: z.string(),
      }),
    )
    .default([]),
  validation: z.object({
    install: command.nullable(),
    build: command,
    tests: z.array(command),
    manual: z.array(z.string()),
  }),
});
export type PairConfig = z.infer<typeof pairConfigSchema>;
export const localBindingSchema = z.object({
  version: z.literal(1),
  pairs: z.record(
    z.string(),
    z.object({ sourcePath: z.string(), targetPath: z.string() }),
  ),
  defaultProvider: z.enum(["codex", "cursor", "claude"]).default("codex"),
});
export type LocalBinding = z.infer<typeof localBindingSchema>;
export const fileChangeSchema = z.object({
  status: z.string(),
  path: z.string(),
  previousPath: z.string().optional(),
});
export const integrationEventSchema = z.object({
  sha,
  parent: sha,
  subject: z.string(),
  date: z.string(),
  constituentCommits: z.array(sha),
  files: z.array(fileChangeSchema),
  empty: z.boolean(),
});
export const snapshotSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  pairId: id,
  createdAt: z.string(),
  sourceSha: sha,
  targetSha: sha,
  baselineSha: sha,
  fetchedAt: z.string().nullable(),
  offline: z.boolean(),
  knowledgeHash: z.string(),
  configHash: z.string(),
  events: z.array(integrationEventSchema),
  coverage: z.object({
    total: z.number(),
    assessed: z.number(),
    unprocessed: z.array(sha),
  }),
  aiAssessedAt: z.string().optional(),
});
export type AnalysisSnapshot = z.infer<typeof snapshotSchema>;
export const classificationSchema = z.enum([
  "missing",
  "partial",
  "present",
  "no_target_impact",
  "superseded",
  "intentional_divergence",
  "needs_investigation",
]);
/** Trimmed text that still contains a visible character. */
export const nonEmptyText = z.string().trim().min(1);
export function requirePersonName(value: unknown, label = "Your name") {
  const parsed = nonEmptyText.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `${label} is required. Enter a non-empty name and try again.`,
    );
  return parsed.data;
}
const evidenceKeys = new Set(["requirements", "intentionalDecision"]);
/** Reject lifecycle, identity, and timestamp writes. Evidence updates are allowlisted. */
export function rejectForbiddenLifecycleWrite(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error(
      "Send classification and evidence only. Status, identity, timestamps, approval, runs, and resolutions change through their own actions.",
    );
  const record = body as Record<string, unknown>;
  const blocked = Object.keys(record).filter((key) => !evidenceKeys.has(key));
  if (blocked.length)
    throw new Error(
      `Cannot update ${blocked.join(", ")}. Save classification and evidence only; status, identity, timestamps, approval, runs, and resolutions change through their own actions.`,
    );
  const decision = record.intentionalDecision;
  if (decision && typeof decision === "object" && !Array.isArray(decision)) {
    const extra = Object.keys(decision as object).filter(
      (key) => key !== "decidedBy" && key !== "reason",
    );
    if (extra.length)
      throw new Error(
        "Record your name and a reason for an intentional difference. The workbench records the decision time.",
      );
    if (
      !nonEmptyText.safeParse((decision as { decidedBy?: unknown }).decidedBy)
        .success ||
      !nonEmptyText.safeParse((decision as { reason?: unknown }).reason).success
    )
      throw new Error(
        "Enter your name and a reason for the intentional difference, then save evidence again.",
      );
  }
}
export const requirementSchema = z.object({
  id: z.string(),
  behavior: z.string(),
  classification: classificationSchema,
  rationale: z.string(),
  sourceEvidence: z.array(z.string()),
  targetEvidence: z.array(z.string()),
  dependencies: z.array(z.string()).default([]),
  featureArea: z.string().default("unassigned"),
  groupKey: z.string().default(""),
  impact: z.string().default(""),
});
export const gapSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  pairId: id,
  integrationSha: sha,
  sourceSubject: z.string(),
  snapshotId: z.string(),
  requirements: z.array(requirementSchema),
  status: z.enum([
    "open",
    "planned",
    "approved",
    "implementing",
    "review_required",
    "changes_requested",
    "verified_local",
    "resolved_no_action",
    "integrated",
  ]),
  intentionalDecision: z
    .object({ reason: z.string(), decidedBy: z.string(), at: z.string() })
    .optional(),
  noActionResolution: z
    .object({
      decidedBy: z.string().min(1),
      reason: z.string().min(1),
      at: z.string(),
      sourceSha: sha,
      targetSha: sha,
      configHash: z.string(),
    })
    .optional(),
  updatedAt: z.string(),
});
export type GapRecord = z.infer<typeof gapSchema>;
export const evidenceUpdateSchema = z
  .object({
    requirements: z.array(
      z
        .object({
          id: z.string().min(1),
          classification: classificationSchema,
          rationale: z.string(),
          sourceEvidence: z.array(z.string()),
          targetEvidence: z.array(z.string()),
          behavior: z.string().optional(),
          dependencies: z.array(z.string()).optional(),
          featureArea: z.string().optional(),
          groupKey: z.string().optional(),
          impact: z.string().optional(),
        })
        .strict(),
    ),
    intentionalDecision: z
      .object({
        decidedBy: nonEmptyText,
        reason: nonEmptyText,
      })
      .strict()
      .optional(),
  })
  .strict();
export type EvidenceUpdate = z.infer<typeof evidenceUpdateSchema>;
export const planQuestionSchema = z.union([
  z.string(),
  z.object({
    question: z.string(),
    answer: z.string(),
  }),
]);
export type PlanQuestion = z.infer<typeof planQuestionSchema>;
export const planSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  gapId: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  sourceBehavior: z.string(),
  targetBehavior: z.string(),
  targetFiles: z.array(z.string()),
  approach: z.string(),
  conventions: z.array(z.string()),
  dependencies: z.array(z.string()),
  regressionTests: z.array(z.string()),
  commands: z.array(command),
  manualScenarios: z.array(z.string()),
  questions: z.array(planQuestionSchema),
  hash: z.string(),
});
export type PlanRevision = z.infer<typeof planSchema>;
export function unansweredPlanQuestions(
  questions: readonly PlanQuestion[],
): PlanQuestion[] {
  return questions.filter((item) => {
    const question = typeof item === "string" ? item : item.question;
    const answer = typeof item === "string" ? "" : item.answer;
    return question.trim().length > 0 && !answer.trim();
  });
}
export const approvalSchema = z.object({
  version: z.literal(1),
  gapId: z.string(),
  planId: z.string(),
  planHash: z.string(),
  sourceSha: sha,
  targetSha: sha,
  knowledgeHash: z.string(),
  configHash: z.string(),
  approvedBy: nonEmptyText,
  approvedAt: z.string(),
});
export type Approval = z.infer<typeof approvalSchema>;
export const checkSchema = z.object({
  name: z.string(),
  command: command.optional(),
  status: z.enum(["passed", "failed", "blocked"]),
  blocking: z.boolean().optional(),
  output: z.string(),
  at: z.string(),
});
export const runSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  gapId: z.string(),
  stage: z.enum([
    "implementing",
    "validating",
    "reviewing",
    "verified_local",
    "interrupted",
    "failed",
  ]),
  provider: z.enum(["codex", "cursor", "claude"]).optional(),
  session: z.string().optional(),
  status: z.string(),
  worktree: z.string(),
  branch: z.string(),
  baseSha: sha,
  diffFingerprint: z.string().optional(),
  checks: z.array(checkSchema),
  manualResults: z
    .array(
      z.object({
        scenario: z.string(),
        status: z.enum(["pending", "passed", "failed"]),
        notes: z.string(),
      }),
    )
    .default([]),
  review: z
    .object({
      verdict: z.enum(["approved", "changes_requested"]),
      findings: z.array(z.string()),
      fingerprint: z.string(),
      at: z.string(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunRecord = z.infer<typeof runSchema>;
export const integrationSchema = z.object({
  version: z.literal(1),
  gapId: z.string(),
  integratedSha: sha,
  observedTargetSha: sha,
  evidence: z.array(z.string()),
  reviewedFiles: z
    .array(z.object({ path: z.string(), blob: sha.nullable() }))
    .default([]),
  verifiedAt: z.string(),
});
export type IntegrationRecord = z.infer<typeof integrationSchema>;
export type CommandSpec = z.infer<typeof command>;
