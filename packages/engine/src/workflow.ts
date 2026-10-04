import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  diffFingerprint,
  git,
  isAncestor,
  processRun,
  resolveCommit,
  verifyPair,
} from "./git.js";
import { hash, Store } from "./store.js";
import {
  evidenceUpdateSchema,
  planSchema,
  rejectForbiddenLifecycleWrite,
  requirePersonName,
  unansweredPlanQuestions,
  type Approval,
  type CommandSpec,
  type GapRecord,
  type PlanRevision,
  type RunRecord,
} from "./schema.js";

const now = () => new Date().toISOString();
export const unboundPairMessage =
  "This pair has no saved checkout paths. Open Setup, save the source and target repositories, then try again.";

export function requirePairBinding<T extends { sourcePath: string; targetPath: string }>(
  binding: T | undefined,
) {
  if (!binding?.sourcePath?.trim() || !binding?.targetPath?.trim())
    throw new Error(unboundPairMessage);
  return binding;
}

/** Both paths of a porcelain v1 `-z` rename or copy, plus ordinary paths. */
export function porcelainStatusPaths(record: string) {
  const parts = record.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3).replace(/\\/g, "/");
    if (status.includes("R") || status.includes("C")) {
      const destination = (parts[++index] || "").replace(/\\/g, "/");
      if (path) paths.push(path);
      if (destination) paths.push(destination);
    } else if (path) paths.push(path);
  }
  return paths;
}

/** Both paths of a `diff --name-status -z` rename or copy. */
export function diffNameStatusPaths(record: string) {
  const parts = record.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const status = parts[index];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = (parts[++index] || "").replace(/\\/g, "/");
      const to = (parts[++index] || "").replace(/\\/g, "/");
      if (from) paths.push(from);
      if (to) paths.push(to);
    } else {
      const file = (parts[++index] || "").replace(/\\/g, "/");
      if (file) paths.push(file);
    }
  }
  return paths;
}

export function implementationAllowed(
  gap: { status: string },
  run?: { stage: string } | null,
) {
  if (gap.status === "approved") return true;
  return (
    gap.status === "implementing" &&
    !!run &&
    (run.stage === "failed" || run.stage === "interrupted")
  );
}

export type ValidationPhase =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "reused";
export type ValidationProgress = {
  index: number;
  total: number;
  name: string;
  phase: ValidationPhase;
  completed: number;
  blocking: boolean;
};
export type ValidationObserver = {
  onProgress?: (progress: ValidationProgress) => void;
  onActivity?: (activity: {
    index: number;
    name: string;
    lastOutputAt: string;
  }) => void;
};
export function validationMilestone(progress: ValidationProgress) {
  const position = `Check ${progress.index + 1} of ${progress.total}: ${progress.name}`;
  const summary =
    progress.phase === "pending"
      ? undefined
      : progress.phase === "running"
        ? position
        : `${progress.name} ${progress.phase}`;
  return {
    activity: "progress" as const,
    ...(summary ? { summary } : {}),
    progress: {
      index: progress.index,
      total: progress.total,
      name: progress.name,
      phase: progress.phase,
      completed: progress.completed,
      blocking: progress.blocking,
    },
  };
}
function notifyProgress(
  observer: ValidationObserver | undefined,
  progress: ValidationProgress,
) {
  try {
    observer?.onProgress?.(progress);
  } catch {
    // Observers report progress. They cannot change authorization or the result.
  }
}

/** A pipeline test step does not block release when it continues on error or ignores the test exit code. */
export function pipelineTestStepIsNonBlocking(pipelineYaml: string) {
  const lines = pipelineYaml.split(/\r?\n/);
  const starts = lines.flatMap((line, index) =>
    /^\s*-\s+(?:script|bash|pwsh|powershell|task)\b/.test(line) ? [index] : [],
  );
  return starts.some((start, index) => {
    const chunk = lines.slice(start, starts[index + 1] ?? lines.length).join("\n");
    const runsTests = /\bnpm test\b/.test(chunk) || /\bng test\b/.test(chunk);
    const continues =
      /continueOnError:\s*true\b/.test(chunk) || /\|\|\s*true\b/.test(chunk);
    return runsTests && continues;
  });
}

function gitShowRevision(spec: CommandSpec) {
  if (!/(^|[\\/])git(\.exe)?$/i.test(spec.executable)) return;
  const showAt = spec.args.indexOf("show");
  const objectName = showAt < 0 ? undefined : spec.args[showAt + 1];
  return objectName?.match(/^([0-9a-f]{7,40}):/i)?.[1];
}

async function commitExists(cwd: string, revision: string) {
  try {
    await git(cwd, "cat-file", "-e", `${revision}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** `git show <commit>:<path>` has to run where that commit exists. */
export async function commandCwd(
  spec: CommandSpec,
  worktree: string,
  sourcePath: string,
) {
  const revision = gitShowRevision(spec);
  if (!revision || (await commitExists(worktree, revision))) return worktree;
  if (sourcePath !== worktree && (await commitExists(sourcePath, revision)))
    return sourcePath;
  return worktree;
}

export function requiredChecksSatisfied(
  checks: readonly { name: string; status: string; blocking?: boolean }[],
) {
  const blocking = checks.filter((check) => check.blocking !== false);
  return (
    blocking.length > 0 &&
    blocking.every((check) => check.status === "passed") &&
    checks.some(
      (check) =>
        check.name === "production build" && check.status === "passed",
    ) &&
    checks.some((check) => check.name === "test")
  );
}

async function pipelineTestsAreNonBlocking(worktree: string) {
  let names: string[];
  try {
    names = await readdir(worktree);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!/^azure.*\.ya?ml$/i.test(name)) continue;
    const text = await readFile(path.join(worktree, name), "utf8");
    if (pipelineTestStepIsNonBlocking(text)) return true;
  }
  return false;
}
export const WINDOWS_WORKTREE_PATH_BUDGET = 240;

function joinFor(platform: NodeJS.Platform, ...parts: string[]) {
  return (platform === "win32" ? path.win32 : path.posix).join(...parts);
}

export function worktreeCheckoutLength(
  worktree: string,
  longestRelativePath: number,
) {
  return worktree.length + 1 + longestRelativePath;
}

export function chooseWorktreePath(input: {
  preferredRoot: string;
  slug: string;
  longestRelativePath: number;
  platform?: NodeJS.Platform;
  shortRoot?: string;
}) {
  const platform = input.platform ?? process.platform;
  const preferred = joinFor(platform, input.preferredRoot, input.slug);
  if (platform !== "win32") return preferred;
  const preferredLength = worktreeCheckoutLength(
    preferred,
    input.longestRelativePath,
  );
  if (preferredLength <= WINDOWS_WORKTREE_PATH_BUDGET) return preferred;
  const shortRoot =
    input.shortRoot ||
    process.env.BRANCH_SYNC_WORKTREE_ROOT ||
    joinFor(platform, os.homedir(), "wt");
  const fallback = joinFor(platform, shortRoot, input.slug);
  const fallbackLength = worktreeCheckoutLength(
    fallback,
    input.longestRelativePath,
  );
  if (fallbackLength <= WINDOWS_WORKTREE_PATH_BUDGET) return fallback;
  throw new Error(
    `Worktree path would exceed Windows limit (${WINDOWS_WORKTREE_PATH_BUDGET}): preferred ${preferredLength} characters, fallback ${fallbackLength} characters`,
  );
}

async function longestTrackedPath(cwd: string, sha: string) {
  const raw = await git(cwd, "ls-tree", "-r", "-z", "--name-only", sha);
  let longest = 0;
  for (const file of raw.split("\0")) {
    if (file.length > longest) longest = file.length;
  }
  return longest;
}

async function branchCheckoutState(
  cwd: string,
  branch: string,
  base: string,
): Promise<"missing" | "reusable" | "occupied"> {
  let sha: string;
  try {
    sha = await git(
      cwd,
      "rev-parse",
      "--verify",
      `refs/heads/${branch}^{commit}`,
    );
  } catch {
    return "missing";
  }
  const list = await git(cwd, "worktree", "list", "--porcelain");
  const checkedOut = list
    .split(/\r?\n/)
    .some((line) => line === `branch refs/heads/${branch}`);
  if (checkedOut) return "occupied";
  return sha === base ? "reusable" : "occupied";
}

async function pruneFailedWorktree(repo: string, worktree: string) {
  try {
    await git(repo, "worktree", "remove", "--force", worktree);
  } catch {
    try {
      await git(repo, "worktree", "prune");
    } catch {}
  }
  await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
}

async function reusableWorktree(previous: RunRecord | undefined, base: string) {
  if (
    !previous ||
    (previous.stage !== "failed" && previous.stage !== "interrupted") ||
    previous.baseSha !== base ||
    !existsSync(previous.worktree)
  )
    return;
  try {
    const [status, head] = await Promise.all([
      git(
        previous.worktree,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ),
      git(previous.worktree, "rev-parse", "HEAD"),
    ]);
    if (!status && head === base)
      return { worktree: previous.worktree, branch: previous.branch };
  } catch {
    return;
  }
}
export class Workflow {
  constructor(readonly store: Store) {}
  async resolveNoAction(
    pairId: string,
    gapId: string,
    decidedBy: string,
    reason: string,
  ) {
    const name = requirePersonName(decidedBy, "Your name");
    const explanation = requirePersonName(reason, "A reason");
    const [gap, snapshot, pair] = await Promise.all([
      this.store.gap(pairId, gapId),
      this.store.latestSnapshot(pairId),
      this.store.pair(pairId),
    ]);
    if (!["open", "planned"].includes(gap.status))
      throw new Error(
        "No-work resolution is only available before implementation",
      );
    if (
      !snapshot ||
      !snapshot.events.some((event) => event.sha === gap.integrationSha)
    )
      throw new Error("Analysis changed; review this gap again");
    const binding = requirePairBinding(
      (await this.store.binding()).pairs[pairId],
    );
    const verified = await verifyPair(
      pair,
      binding.sourcePath,
      binding.targetPath,
    );
    if (
      verified.sourceSha !== snapshot.sourceSha ||
      verified.targetSha !== snapshot.targetSha ||
      hash(pair) !== snapshot.configHash
    )
      throw new Error("Refs or knowledge changed; analyze again");
    const noWork = new Set([
      "present",
      "superseded",
      "intentional_divergence",
      "no_target_impact",
    ]);
    if (
      !gap.requirements.length ||
      gap.requirements.some(
        (r) =>
          !noWork.has(r.classification) ||
          !r.rationale.trim() ||
          !r.sourceEvidence.some((item) => item.trim()) ||
          !r.targetEvidence.some((item) => item.trim()),
      )
    )
      throw new Error(
        "Classify every requirement as no target work and record source and target evidence",
      );
    if (
      gap.requirements.some(
        (r) => r.classification === "intentional_divergence",
      ) &&
      (!gap.intentionalDecision?.reason || !gap.intentionalDecision.decidedBy)
    )
      throw new Error("Intentional divergence needs a recorded decision");
    gap.noActionResolution = {
      decidedBy: name,
      reason: explanation,
      at: now(),
      sourceSha: snapshot.sourceSha,
      targetSha: snapshot.targetSha,
      configHash: snapshot.configHash,
    };
    gap.status = "resolved_no_action";
    gap.updatedAt = now();
    await this.store.saveGap(gap);
    return gap;
  }
  async revisePlan(
    pairId: string,
    gapId: string,
    input: Omit<
      PlanRevision,
      "version" | "id" | "gapId" | "revision" | "createdAt" | "hash"
    >,
  ) {
    const gap = await this.store.gap(pairId, gapId);
    const revision =
      (await this.store.latestPlan(pairId, gapId))?.revision ?? 0;
    const data = {
      version: 1 as const,
      id: randomUUID(),
      gapId,
      revision: revision + 1,
      createdAt: now(),
      ...input,
    };
    const plan = planSchema.parse({ ...data, hash: hash(data) });
    await this.store.savePlan(pairId, plan);
    gap.status = "planned";
    gap.updatedAt = now();
    await this.store.saveGap(gap);
    return plan;
  }
  async updateEvidence(pairId: string, gapId: string, body: unknown) {
    rejectForbiddenLifecycleWrite(body);
    const update = evidenceUpdateSchema.safeParse(body);
    if (!update.success)
      throw new Error(
        "Save classification, rationale, and source and target evidence only. Check those fields and try again.",
      );
    const existing = await this.store.gap(pairId, gapId);
    if (["integrated", "resolved_no_action"].includes(existing.status))
      throw new Error(
        "This gap is already closed. Review the recorded outcome instead of editing evidence.",
      );
    const incoming = new Map(
      update.data.requirements.map((requirement) => [requirement.id, requirement]),
    );
    if (
      update.data.requirements.length !== existing.requirements.length ||
      existing.requirements.some((requirement) => !incoming.has(requirement.id))
    )
      throw new Error(
        "These requirement identities do not match the gap. Refresh the page and edit the current evidence.",
      );
    existing.requirements = existing.requirements.map((requirement) => {
      const next = incoming.get(requirement.id)!;
      return {
        ...requirement,
        classification: next.classification,
        rationale: next.rationale,
        sourceEvidence: next.sourceEvidence.map((item) => item.trim()).filter(Boolean),
        targetEvidence: next.targetEvidence.map((item) => item.trim()).filter(Boolean),
        ...(next.behavior !== undefined ? { behavior: next.behavior } : {}),
        ...(next.dependencies ? { dependencies: next.dependencies } : {}),
        ...(next.featureArea !== undefined
          ? { featureArea: next.featureArea }
          : {}),
        ...(next.groupKey !== undefined ? { groupKey: next.groupKey } : {}),
        ...(next.impact !== undefined ? { impact: next.impact } : {}),
      };
    });
    if (
      existing.requirements.some(
        (requirement) => requirement.classification === "intentional_divergence",
      )
    ) {
      if (!update.data.intentionalDecision)
        throw new Error(
          "Intentional difference requires your name and a reason. Enter both, then save evidence again.",
        );
      existing.intentionalDecision = {
        decidedBy: update.data.intentionalDecision.decidedBy,
        reason: update.data.intentionalDecision.reason,
        at: now(),
      };
    }
    existing.updatedAt = now();
    await this.store.saveGap(existing);
    return existing;
  }
  async approve(
    pairId: string,
    gapId: string,
    approvedBy: string,
  ): Promise<Approval> {
    const name = requirePersonName(approvedBy, "Your name");
    const [gap, plan, snapshot] = await Promise.all([
      this.store.gap(pairId, gapId),
      this.store.latestPlan(pairId, gapId),
      this.store.latestSnapshot(pairId),
    ]);
    if (!plan || !snapshot)
      throw new Error("A plan and current analysis are required");
    if (
      !plan.sourceBehavior ||
      !plan.targetBehavior ||
      !plan.approach ||
      !plan.targetFiles.length ||
      !plan.regressionTests.length ||
      unansweredPlanQuestions(plan.questions).length
    )
      throw new Error(
        "Plan lacks required behavior, files, approach, tests, or has unresolved questions",
      );
    if (
      gap.requirements.some((r) => r.classification === "needs_investigation")
    )
      throw new Error("Resolve uncertain classifications before approval");
    if (
      gap.requirements.some(
        (r) =>
          !r.rationale.trim() ||
          !r.sourceEvidence.length ||
          !r.targetEvidence.length,
      )
    )
      throw new Error(
        "Every requirement needs a rationale and source and target evidence",
      );
    if (
      gap.requirements.some(
        (r) => r.classification === "intentional_divergence",
      ) &&
      !gap.intentionalDecision?.reason
    )
      throw new Error(
        "Intentional divergence needs a developer decision and reason",
      );
    for (const dependency of plan.dependencies) {
      const dependent = await this.store.gap(pairId, dependency);
      if (dependent.status !== "integrated")
        throw new Error(`Plan dependency remains unresolved: ${dependency}`);
    }
    const pair = await this.store.pair(pairId),
      binding = requirePairBinding((await this.store.binding()).pairs[pairId]);
    const verified = await verifyPair(
      pair,
      binding.sourcePath,
      binding.targetPath,
    );
    if (
      verified.sourceSha !== snapshot.sourceSha ||
      verified.targetSha !== snapshot.targetSha ||
      hash(pair) !== snapshot.configHash
    )
      throw new Error("Refs or knowledge changed; analyze again");
    const approval: Approval = {
      version: 1,
      gapId,
      planId: plan.id,
      planHash: plan.hash,
      sourceSha: snapshot.sourceSha,
      targetSha: snapshot.targetSha,
      knowledgeHash: snapshot.knowledgeHash,
      configHash: snapshot.configHash,
      approvedBy: name,
      approvedAt: now(),
    };
    await this.store.saveApproval(pairId, approval);
    gap.status = "approved";
    gap.updatedAt = now();
    await this.store.saveGap(gap);
    return approval;
  }
  async requireApproval(pairId: string, gapId: string) {
    const [pair, plan, approval, snapshot, binding] = await Promise.all([
      this.store.pair(pairId),
      this.store.latestPlan(pairId, gapId),
      this.store.approval(pairId, gapId),
      this.store.latestSnapshot(pairId),
      this.store.binding(),
    ]);
    if (!plan || !approval || !snapshot)
      throw new Error("No approved plan for this gap");
    const local = requirePairBinding(binding.pairs[pairId]);
    const verified = await verifyPair(
      pair,
      local.sourcePath,
      local.targetPath,
    );
    if (
      approval.planId !== plan.id ||
      approval.planHash !== plan.hash ||
      approval.sourceSha !== snapshot.sourceSha ||
      approval.targetSha !== snapshot.targetSha ||
      approval.knowledgeHash !== snapshot.knowledgeHash ||
      approval.configHash !== snapshot.configHash ||
      verified.sourceSha !== approval.sourceSha ||
      verified.targetSha !== approval.targetSha ||
      hash(pair) !== snapshot.configHash
    )
      throw new Error("Approval is stale; analyze, revise, and approve again");
    return { pair, plan, approval, binding: local };
  }
  async createRun(pairId: string, gapId: string): Promise<RunRecord> {
    const { approval, binding, pair, plan } = await this.requireApproval(
      pairId,
      gapId,
    );
    const current = await this.store.gap(pairId, gapId);
    const previous = await this.store.latestRun(pairId, gapId);
    if (!implementationAllowed(current, previous))
      throw new Error(
        "Approve the current plan before implementation. If a check already ran, open validation and run the checks again.",
      );
    const base = approval.targetSha;
    const reused = await reusableWorktree(previous, base);
    let branch: string;
    let worktree: string;
    if (reused) {
      branch = reused.branch;
      worktree = reused.worktree;
    } else {
      const longestRelativePath = await longestTrackedPath(
        binding.targetPath,
        base,
      );
      const preferredRoot = path.join(this.store.root, ".local", "worktrees");
      const slug = `${pairId}-${gapId.slice(-10)}`.replace(/[^a-z0-9-]/g, "-");
      let suffix = 1;
      let createBranch = true;
      while (true) {
        const candidate = suffix === 1 ? slug : `${slug}-${suffix}`;
        branch = `codex/sync-${candidate}`;
        worktree = chooseWorktreePath({
          preferredRoot,
          slug: candidate,
          longestRelativePath,
        });
        const pathTaken = existsSync(worktree);
        const branchState = await branchCheckoutState(
          binding.targetPath,
          branch,
          base,
        );
        if (!pathTaken && branchState !== "occupied") {
          createBranch = branchState === "missing";
          break;
        }
        suffix += 1;
      }
      await mkdir(path.dirname(worktree), { recursive: true });
      try {
        if (createBranch)
          await git(
            binding.targetPath,
            "worktree",
            "add",
            "-b",
            branch,
            worktree,
            base,
          );
        else
          await git(binding.targetPath, "worktree", "add", worktree, branch);
      } catch (error) {
        await pruneFailedWorktree(binding.targetPath, worktree);
        throw error;
      }
    }
    const run: RunRecord = {
      version: 1,
      id: randomUUID(),
      gapId,
      stage: "implementing",
      status: "Worktree ready",
      worktree,
      branch,
      baseSha: base,
      checks: [],
      manualResults: [
        ...new Set([...pair.validation.manual, ...plan.manualScenarios]),
      ].map((scenario) => ({ scenario, status: "pending", notes: "" })),
      createdAt: now(),
      updatedAt: now(),
    };
    await this.store.saveRun(pairId, run);
    const gap = await this.store.gap(pairId, gapId);
    gap.status = "implementing";
    gap.updatedAt = now();
    await this.store.saveGap(gap);
    return run;
  }
  async checkScope(run: RunRecord, plan: PlanRevision) {
    const [status, committed] = await Promise.all([
      git(
        run.worktree,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ),
      git(
        run.worktree,
        "diff",
        "--name-status",
        "-z",
        "-M",
        run.baseSha,
        "HEAD",
      ),
    ]);
    const paths = [
      ...new Set([
        ...porcelainStatusPaths(status),
        ...diffNameStatusPaths(committed),
      ]),
    ];
    const allowed = new Set(plan.targetFiles.map((x) => x.replace(/\\/g, "/")));
    const outside = paths.filter((x) => !allowed.has(x));
    if (outside.length)
      throw new Error(`Changes outside approved files: ${outside.join(", ")}`);
  }
  async validate(
    pairId: string,
    gapId: string,
    signal?: AbortSignal,
    observer?: ValidationObserver,
  ) {
    const { pair, plan, binding } = await this.requireApproval(pairId, gapId);
    const run = await this.store.latestRun(pairId, gapId);
    const gap = await this.store.gap(pairId, gapId);
    if (!run)
      throw new Error(
        "No implementation run. Start implementation, then run validation.",
      );
    if (["open", "planned", "resolved_no_action", "integrated"].includes(gap.status))
      throw new Error(
        gap.status === "integrated" || gap.status === "resolved_no_action"
          ? "This gap is already closed. Review the recorded outcome instead of running validation."
          : "Approve the plan and finish implementation before running validation.",
      );
    await this.checkScope(run, plan);
    const fingerprint = await diffFingerprint(run.worktree, run.baseSha);
    const prior = run.diffFingerprint === fingerprint ? run.checks : [];
    const testsNonBlocking = await pipelineTestsAreNonBlocking(run.worktree);
    run.stage = "validating";
    run.checks = [];
    run.review = undefined;
    run.diffFingerprint = fingerprint;
    run.updatedAt = now();
    await this.store.saveRun(pairId, run);
    const checks: { name: string; spec: CommandSpec; blocking: boolean }[] =
      [];
    if (pair.validation.install)
      checks.push({
        name: "install",
        spec: pair.validation.install,
        blocking: true,
      });
    checks.push({
      name: "production build",
      spec: pair.validation.build,
      blocking: true,
    });
    for (const spec of pair.validation.tests)
      checks.push({ name: "test", spec, blocking: !testsNonBlocking });
    for (const spec of plan.commands)
      checks.push({ name: "test", spec, blocking: true });
    if (!checks.some((c) => c.name === "test"))
      throw new Error("No focused test command configured");
    const total = checks.length;
    checks.forEach((check, index) =>
      notifyProgress(observer, {
        index,
        total,
        name: check.name,
        phase: "pending",
        completed: 0,
        blocking: check.blocking,
      }),
    );
    let completed = 0;
    for (let index = 0; index < checks.length; index++) {
      const check = checks[index];
      const reused = prior.find(
        (item) =>
          item.status === "passed" &&
          item.name === check.name &&
          item.command?.executable === check.spec.executable &&
          JSON.stringify(item.command?.args ?? []) ===
            JSON.stringify(check.spec.args),
      );
      if (reused) {
        completed += 1;
        run.checks.push({ ...reused, blocking: check.blocking, at: now() });
        notifyProgress(observer, {
          index,
          total,
          name: check.name,
          phase: "reused",
          completed,
          blocking: check.blocking,
        });
        await this.store.saveRun(pairId, run);
        continue;
      }
      notifyProgress(observer, {
        index,
        total,
        name: check.name,
        phase: "running",
        completed,
        blocking: check.blocking,
      });
      try {
        const output = await processRun(
          check.spec.executable,
          check.spec.args,
          await commandCwd(check.spec, run.worktree, binding.sourcePath),
          signal,
          (activity) => {
            try {
              observer?.onActivity?.({
                index,
                name: check.name,
                lastOutputAt: activity.lastOutputAt,
              });
            } catch {
              // Activity timestamps cannot change the check result.
            }
          },
        );
        run.checks.push({
          name: check.name,
          command: check.spec,
          status: "passed",
          blocking: check.blocking,
          output: output.slice(-12000),
          at: now(),
        });
        completed += 1;
        notifyProgress(observer, {
          index,
          total,
          name: check.name,
          phase: "passed",
          completed,
          blocking: check.blocking,
        });
      } catch (error) {
        if (signal?.aborted) {
          run.stage = "interrupted";
          run.status =
            "Validation cancelled. The worktree is retained; run the checks again when you are ready.";
          run.updatedAt = now();
          await this.store.saveRun(pairId, run);
          throw new Error(run.status);
        }
        const buildPassed = run.checks.some(
          (item) =>
            item.name === "production build" && item.status === "passed",
        );
        const blocking = check.blocking || !buildPassed;
        run.checks.push({
          name: check.name,
          command: check.spec,
          status: "failed",
          blocking,
          output: String(error),
          at: now(),
        });
        completed += 1;
        notifyProgress(observer, {
          index,
          total,
          name: check.name,
          phase: "failed",
          completed,
          blocking,
        });
        if (blocking) {
          run.stage = "failed";
          run.status = String(error);
          await this.store.saveRun(pairId, run);
          return run;
        }
      }
      await this.store.saveRun(pairId, run);
    }
    run.updatedAt = now();
    if (run.manualResults.some((x) => x.status !== "passed")) {
      run.stage = "validating";
      run.status = run.checks.some(
        (check) => check.status === "failed" && check.blocking === false,
      )
        ? "Production build passed. Pipeline tests are non-blocking; record manual scenarios to continue."
        : "Manual validation outcomes required";
      await this.store.saveRun(pairId, run);
      return run;
    }
    await this.markReviewReady(pairId, gapId, run);
    return run;
  }
  private async markReviewReady(pairId: string, gapId: string, run: RunRecord) {
    run.stage = "reviewing";
    run.status = run.checks.some(
      (check) => check.status === "failed" && check.blocking === false,
    )
      ? "Production build passed with non-blocking test failures; independent review required"
      : "Validation passed; independent review required";
    run.updatedAt = now();
    await this.store.saveRun(pairId, run);
    const gap = await this.store.gap(pairId, gapId);
    gap.status = "review_required";
    gap.updatedAt = now();
    await this.store.saveGap(gap);
  }
  async recordManual(
    pairId: string,
    gapId: string,
    scenario: string,
    status: "passed" | "failed",
    notes: string,
  ) {
    const run = await this.store.latestRun(pairId, gapId);
    if (!run || run.stage !== "validating")
      throw new Error("No run awaiting manual validation");
    if (!notes.trim())
      throw new Error("Manual outcome needs observation notes");
    const item = run.manualResults.find((x) => x.scenario === scenario);
    if (!item) throw new Error("Unknown manual scenario");
    item.status = status;
    item.notes = notes;
    run.updatedAt = now();
    await this.store.saveRun(pairId, run);
    if (
      run.manualResults.every((x) => x.status === "passed") &&
      requiredChecksSatisfied(run.checks)
    ) {
      if (
        run.diffFingerprint !==
        (await diffFingerprint(run.worktree, run.baseSha))
      )
        throw new Error("Diff changed after validation; run checks again");
      await this.markReviewReady(pairId, gapId, run);
    }
    return run;
  }
  async recordReview(
    pairId: string,
    gapId: string,
    verdict: "approved" | "changes_requested",
    findings: string[],
  ) {
    const run = await this.store.latestRun(pairId, gapId);
    if (!run) throw new Error("No run");
    const current = await diffFingerprint(run.worktree, run.baseSha);
    if (current !== run.diffFingerprint)
      throw new Error("Diff changed after validation; validate again");
    if (
      !requiredChecksSatisfied(run.checks) ||
      run.manualResults.some((x) => x.status !== "passed")
    )
      throw new Error("Required checks and manual scenarios have not passed");
    run.review = { verdict, findings, fingerprint: current, at: now() };
    run.stage = verdict === "approved" ? "verified_local" : "reviewing";
    run.status =
      verdict === "approved" ? "Ready for Git handoff" : "Changes requested";
    run.updatedAt = now();
    await this.store.saveRun(pairId, run);
    const gap = await this.store.gap(pairId, gapId);
    gap.status =
      verdict === "approved" ? "verified_local" : "changes_requested";
    gap.updatedAt = now();
    await this.store.saveGap(gap);
    return run;
  }
  async confirmIntegration(
    pairId: string,
    gapId: string,
    integratedSha: string,
    evidence: string[],
  ) {
    const pair = await this.store.pair(pairId),
      binding = requirePairBinding((await this.store.binding()).pairs[pairId]),
      approval = await this.store.approval(pairId, gapId),
      plan = await this.store.latestPlan(pairId, gapId);
    if (
      !approval ||
      !plan ||
      approval.planId !== plan.id ||
      approval.planHash !== plan.hash ||
      approval.configHash !== hash(pair)
    )
      throw new Error("Approved plan or configuration changed");
    if (
      (await resolveCommit(binding.sourcePath, pair.source.ref)) !==
      approval.sourceSha
    )
      throw new Error(
        "Source ref changed after approval; analyze and review again",
      );
    const run = await this.store.latestRun(pairId, gapId);
    if (
      !run?.review ||
      run.review.verdict !== "approved" ||
      run.review.fingerprint !==
        (await diffFingerprint(run.worktree, run.baseSha))
    )
      throw new Error("Independent review is missing or stale");
    await git(binding.targetPath, "fetch", pair.target.remote);
    const targetSha = await git(
      binding.targetPath,
      "rev-parse",
      `${pair.target.ref}^{commit}`,
    );
    const commit = await git(
      binding.targetPath,
      "rev-parse",
      `${integratedSha}^{commit}`,
    );
    if (!(await isAncestor(binding.targetPath, commit, targetSha)))
      throw new Error("Integration commit is not reachable from target ref");
    if (!evidence.length) throw new Error("Verification evidence is required");
    const reviewedFiles: { path: string; blob: string | null }[] = [];
    for (const file of plan.targetFiles) {
      const delivered = await git(
        run.worktree,
        "hash-object",
        "--",
        file,
      ).catch(() => null);
      const observed = await git(
        binding.targetPath,
        "rev-parse",
        `${targetSha}:${file}`,
      ).catch(() => null);
      if (delivered !== observed)
        throw new Error(
          `Reviewed file differs on target: ${file}; fresh validation and review required`,
        );
      reviewedFiles.push({ path: file, blob: observed });
    }
    await this.store.saveIntegration(pairId, {
      version: 1,
      gapId,
      integratedSha: commit,
      observedTargetSha: targetSha,
      evidence,
      reviewedFiles,
      verifiedAt: now(),
    });
    const gap = await this.store.gap(pairId, gapId);
    gap.status = "integrated";
    gap.updatedAt = now();
    await this.store.saveGap(gap);
    return gap;
  }
}
