import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  Store,
  Workflow,
  pairConfigSchema,
  localBindingSchema,
  planQuestionSchema,
  unboundPairMessage,
  validationMilestone,
  git,
  listRefs,
  diffFingerprint,
  completeDiff,
} from "@sync/engine";
import { Jobs } from "./jobs.js";
import { openWorktree } from "./editor.js";
import { registerSetup } from "./setup.js";
import {
  applyAssessment,
  assessmentPrompt,
  eventChanges,
  guardRequirement,
} from "./analysis.js";
import { extractAgentJson } from "./agent-json.js";
import {
  cursorAcpResponse,
  normalizeAgentActivity,
  probeProvider,
  selectedProvider,
  runAgent,
  type ProviderName,
  type Role,
} from "./providers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export function createApp(
  root = path.resolve(here, "../../.."),
  shutdown?: () => void,
) {
  const app = Fastify({
    logger:
      process.env.SYNC_BACKGROUND === "1"
        ? { file: path.join(root, ".local", "server.log") }
        : true,
    bodyLimit: 2_000_000,
  });
  const store = new Store(root),
    workflow = new Workflow(store),
    jobs = new Jobs(root),
    token = randomBytes(32).toString("hex");
  app.addHook("onReady", async () => jobs.recover());
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))
      return reply.code(403).send({ error: "Invalid origin" });
    if (
      req.url.startsWith("/api/") &&
      req.method !== "GET" &&
      req.headers["x-sync-token"] !== token
    )
      return reply.code(403).send({ error: "Missing local session token" });
  });
  app.setErrorHandler((error, _req, reply) => {
    const issue = error as Error & { statusCode?: number };
    return reply
      .code(
        issue.statusCode && issue.statusCode >= 400 ? issue.statusCode : 400,
      )
      .send({ error: issue.message });
  });
  app.get("/api/session", async () => ({ token }));
  const canonicalRoot = realpathSync(root);
  const checkoutId = createHash("sha256")
    .update(
      process.platform === "win32"
        ? canonicalRoot.toLowerCase()
        : canonicalRoot,
    )
    .digest("hex");
  let buildFingerprint = "development";
  try {
    buildFingerprint = JSON.parse(
      readFileSync(path.join(root, ".local", "build.json"), "utf8"),
    ).fingerprint;
  } catch {}
  const runtime = () => ({
    application: "branch-sync-workbench",
    checkoutId,
    buildFingerprint,
    pid: process.pid,
    activeJobs: [...jobs.all.values()].filter((j) =>
      ["queued", "running"].includes(j.status),
    ).length,
    canStop: !!shutdown,
  });
  app.get("/api/runtime", async () => runtime());
  let stopping = false;
  app.addHook("preHandler", async (req, reply) => {
    if (stopping && req.method !== "GET")
      return reply
        .code(503)
        .send({ error: "Workbench is stopping. Start it again to continue." });
  });
  app.post("/api/runtime/stop", async () => {
    if (!shutdown)
      throw new Error("Stop this development server from its terminal.");
    if (runtime().activeJobs)
      throw new Error(
        "Wait for active jobs to finish or cancel them in Activity before stopping.",
      );
    stopping = true;
    setTimeout(() => {
      void app.close().then(shutdown);
    }, 100).unref();
    return { stopping: true };
  });
  registerSetup(app, store, root);
  app.get("/api/providers", async () =>
    Promise.all(
      (["codex", "cursor", "claude"] as ProviderName[]).map((p) =>
        probeProvider(p, root),
      ),
    ),
  );
  app.get("/api/health", async () => ({
    runtime: runtime(),
    pairs: await Promise.all(
      (await store.pairs()).map(async (p) => {
        const gaps = await store.gaps(p.id);
        const snapshot = await store.latestSnapshot(p.id);
        const current = new Set(snapshot?.events.map((event) => event.sha));
        const decisions = new Map<string, number>();
        if (snapshot?.aiAssessedAt)
          for (const gap of gaps) {
            if (!current.has(gap.integrationSha)) continue;
            for (const requirement of gap.requirements) {
              const key = requirement.groupKey || `${gap.id}:${requirement.id}`;
              const rank = ["missing", "partial"].includes(
                requirement.classification,
              )
                ? 2
                : requirement.classification === "needs_investigation"
                  ? 1
                  : 0;
              decisions.set(key, Math.max(rank, decisions.get(key) ?? -1));
            }
          }
        const local = (await store.binding()).pairs[p.id];
        const ranked = [...gaps]
          .filter(
            (g) =>
              !["integrated", "resolved_no_action"].includes(g.status) &&
              (g.status !== "open" ||
                g.requirements.some((r) =>
                  ["missing", "partial", "needs_investigation"].includes(
                    r.classification,
                  ),
                )),
          )
          .sort((a, b) => {
            const rank = (gap: typeof a) =>
              gap.requirements.some(
                (r) => r.classification === "needs_investigation",
              )
                ? 0
                : gap.status === "changes_requested"
                  ? 1
                  : gap.status === "review_required"
                    ? 2
                    : gap.status === "verified_local"
                      ? 3
                      : 4;
            return rank(a) - rank(b);
          });
        return {
          id: p.id,
          name: p.name,
          bound: !!local?.sourcePath?.trim() && !!local?.targetPath?.trim(),
          snapshot,
          portCandidates: [...decisions.values()].filter((rank) => rank === 2)
            .length,
          investigations: [...decisions.values()].filter((rank) => rank === 1)
            .length,
          gaps: gaps.filter(
            (g) =>
              !["integrated", "resolved_no_action"].includes(g.status) &&
              (g.status !== "open" ||
                g.requirements.some((r) =>
                  ["missing", "partial", "needs_investigation"].includes(
                    r.classification,
                  ),
                )),
          ).length,
          awaitingIntegration: gaps.filter((g) => g.status === "verified_local")
            .length,
          nextGap: ranked[0]
            ? {
                id: ranked[0].id,
                title:
                  ranked[0].requirements[0]?.behavior ||
                  ranked[0].sourceSubject,
                status: ranked[0].status,
                needsInvestigation: ranked[0].requirements.some(
                  (r) => r.classification === "needs_investigation",
                ),
              }
            : null,
        };
      }),
    ),
    jobs: [...jobs.all.values()].map(({ id, kind, pairId, gapId, status }) => ({
      id,
      kind,
      pairId,
      gapId,
      status,
    })),
  }));
  app.get("/api/pairs", async () => ({
    pairs: await store.pairs(),
    binding: await store.binding(),
  }));
  app.post("/api/pairs", async (req) => {
    const pair = pairConfigSchema.parse(req.body);
    await store.savePair(pair);
    return pair;
  });
  app.post("/api/bindings", async (req) => {
    const binding = localBindingSchema.parse(req.body);
    await store.saveBinding(binding);
    return binding;
  });
  app.get<{ Params: { id: string } }>("/api/pairs/:id/refs", async (req) => {
    const binding = (await store.binding()).pairs[req.params.id];
    if (!binding?.sourcePath?.trim() || !binding?.targetPath?.trim())
      throw new Error(unboundPairMessage);
    return {
      source: await listRefs(binding.sourcePath),
      target: await listRefs(binding.targetPath),
    };
  });
  app.get<{ Params: { id: string } }>(
    "/api/pairs/:id/snapshot",
    async (req) => ({
      snapshot: await store.latestSnapshot(req.params.id),
      gaps: await store.gaps(req.params.id),
      integrations: await store.integrations(req.params.id),
    }),
  );
  const agentAnswer = (
    provider: ProviderName,
    type: string,
    answer: unknown,
  ) => {
    if (provider === "codex") {
      const value = answer as { decision?: string; answers?: unknown };
      return type.includes("requestApproval")
        ? { decision: value?.decision || answer }
        : { answers: value?.answers || answer };
    }
    return cursorAcpResponse(type, answer) ?? answer;
  };
  app.post<{ Params: { id: string }; Body: { offline?: boolean } }>(
    "/api/pairs/:id/analyze",
    async (req) => {
      const { id } = req.params;
      const offline = !!req.body?.offline;
      const job = jobs.enqueue("analyze", id, undefined, async (job) => {
        const snapshot = await store.scan(id, offline);
        if (!snapshot.coverage.unprocessed.length) {
          snapshot.aiAssessedAt = new Date().toISOString();
          await store.saveSnapshot(snapshot);
          return snapshot;
        }
        const pair = await store.pair(id);
        const binding = await store.binding();
        const local = binding.pairs[id];
        const provider = selectedProvider(binding);
        const capability = await probeProvider(provider, root);
        if (!capability.available)
          throw new Error(
            `${provider} unavailable: ${capability.error}. Git scan saved; AI assessment remains pending.`,
          );
        const pending = snapshot.events.filter((event) =>
          snapshot.coverage.unprocessed.includes(event.sha),
        );
        const changes = await eventChanges(local.sourcePath, pending);
        let observedSteps = 0;
        const result = await runAgent(
          provider,
          "analyst",
          assessmentPrompt(
            pair,
            snapshot,
            local.sourcePath,
            local.targetPath,
            changes,
          ),
          local.targetPath,
          job.abort.signal,
          () => {
            observedSteps++;
            if (observedSteps % 50 === 0)
              jobs.emit(job, "progress", {
                activity: "phase",
                summary: "Comparing source and target changes",
                observedSteps,
              });
          },
          async (type, params) =>
            agentAnswer(provider, type, await jobs.ask(job, type, params)),
        );
        return applyAssessment(store, snapshot, result.text, changes);
      });
      return { jobId: job.id };
    },
  );
  const agentJob = (
    kind: string,
    pairId: string,
    gapId: string,
    role: Role,
    work: (text: string, session: string) => Promise<unknown>,
    cwd: () => Promise<string>,
    prompt: () => Promise<string>,
    before?: () => Promise<void>,
  ) =>
    jobs.enqueue(kind, pairId, gapId, async (job) => {
      const other = jobs.activeLifecycle(pairId, gapId, job.id);
      if (other)
        throw new Error(
          `A ${other.kind} job is already ${other.status} for this gap. Open Activity and follow that job, or cancel it before starting another.`,
        );
      if (before) await before();
      const pair = await store.pair(pairId),
        binding = await store.binding(),
        provider = selectedProvider(binding);
      const capability = await probeProvider(provider, root);
      if (!capability.available)
        throw new Error(`${provider} unavailable: ${capability.error}`);
      try {
        const result = await runAgent(
          provider,
          role,
          await prompt(),
          await cwd(),
          job.abort.signal,
          (event) => {
            if (event.type === "text") {
              jobs.emit(job, "text", event.data);
              return;
            }
            const normalized = normalizeAgentActivity(event);
            if ("ignore" in normalized && normalized.ignore) return;
            jobs.emit(
              job,
              normalized.activity === "technical" ? "technical" : "activity",
              {
                activity: normalized.activity,
                summary: "summary" in normalized ? normalized.summary : undefined,
                subject: "subject" in normalized ? normalized.subject : undefined,
                rawType: event.type,
                raw: event.data,
              },
            );
          },
          async (type, params) =>
            agentAnswer(provider, type, await jobs.ask(job, type, params)),
        );
        return work(result.text, result.session);
      } catch (error) {
        if (role === "implementer") {
          const run = await store.latestRun(pairId, gapId);
          if (run) {
            run.stage = job.abort.signal.aborted ? "interrupted" : "failed";
            run.status = String(error);
            run.updatedAt = new Date().toISOString();
            await store.saveRun(pairId, run);
          }
        }
        throw error;
      }
    });
  const parseAgentJson = (text: string): any => extractAgentJson(text);
  app.get<{
    Params: { pairId: string; gapId: string };
    Querystring: { focus?: string };
  }>("/api/pairs/:pairId/gaps/:gapId", async (req) => {
    const { pairId, gapId } = req.params;
    const gap = await store.gap(pairId, gapId);
    const snapshot = await store.latestSnapshot(pairId);
    const focus = req.query.focus;
    const focused =
      focus &&
      gap.requirements.some(
        (requirement) =>
          requirement.groupKey === focus || requirement.id === focus,
      )
        ? gap.requirements.filter(
            (requirement) =>
              requirement.groupKey === focus || requirement.id === focus,
          )
        : gap.requirements;
    const relatedKeys = new Set(
      focused.map((requirement) => requirement.groupKey).filter(Boolean),
    );
    const relatedGaps = relatedKeys.size
      ? (await store.gaps(pairId)).filter((candidate) =>
          candidate.requirements.some((requirement) =>
            relatedKeys.has(requirement.groupKey),
          ),
        )
      : [gap];
    const binding = (await store.binding()).pairs[pairId];
    const pair = await store.pair(pairId);
    const sourceRepository =
      pair.source.identity ||
      (binding?.sourcePath
        ? await git(
            binding.sourcePath,
            "remote",
            "get-url",
            pair.source.remote,
          ).catch(() => "")
        : "");
    const sourceEvents =
      snapshot?.events.filter((event) =>
        relatedGaps.some((candidate) => candidate.integrationSha === event.sha),
      ) || [];
    return {
      gap,
      relatedGaps: relatedGaps.map((candidate) => ({
        id: candidate.id,
        integrationSha: candidate.integrationSha,
        status: candidate.status,
      })),
      sourceRepository,
      sourceEvents: await Promise.all(
        sourceEvents.map(async (event) => ({
          ...event,
          commits: await Promise.all(
            event.constituentCommits.map(async (sha) => {
              const [subject = "", date = ""] = binding?.sourcePath
                ? (
                    await git(
                      binding.sourcePath,
                      "show",
                      "-s",
                      "--format=%s%n%aI",
                      sha,
                    ).catch(() => "")
                  ).split("\n")
                : [];
              return { sha, subject, date };
            }),
          ),
        })),
      ),
      plan: await store.latestPlan(pairId, gapId),
      approval: await store.approval(pairId, gapId),
      run: await store.latestRun(pairId, gapId),
    };
  });
  app.post<{ Params: { pairId: string; gapId: string } }>(
    "/api/pairs/:pairId/gaps/:gapId/assess",
    async (req) => {
      const { pairId, gapId } = req.params;
      const binding = (await store.binding()).pairs[pairId];
      const gap = await store.gap(pairId, gapId);
      const event = (await store.latestSnapshot(pairId))?.events.find(
        (e) => e.sha === gap.integrationSha,
      );
      if (!event)
        throw new Error("Integration event missing from latest snapshot");
      const change = (await eventChanges(binding.sourcePath, [event])).get(
        event.sha,
      );
      const job = agentJob(
        "assess",
        pairId,
        gapId,
        "analyst",
        async (text) => {
          const proposal = z
            .object({
              requirements: z.array(
                z.object({
                  behavior: z.string(),
                  classification: z.enum([
                    "missing",
                    "partial",
                    "present",
                    "no_target_impact",
                    "superseded",
                    "intentional_divergence",
                    "needs_investigation",
                  ]),
                  rationale: z.string(),
                  sourceEvidence: z.array(z.string()),
                  targetEvidence: z.array(z.string()),
                  dependencies: z.array(z.string()),
                  featureArea: z.string(),
                  groupKey: z.string().optional(),
                  impact: z.string().optional(),
                }),
              ),
            })
            .parse(parseAgentJson(text));
          gap.requirements = proposal.requirements.map((r, i) => {
            const guarded = guardRequirement(r, {
              intentionalDecision: gap.intentionalDecision,
              symbols: change?.symbols,
            });
            return {
              ...r,
              rationale: guarded.rationale,
              classification: guarded.classification,
              id: `${gapId}-${i + 1}`,
              groupKey: r.groupKey || gap.requirements[i]?.groupKey || "",
              impact: r.impact || gap.requirements[i]?.impact || "",
            };
          });
          gap.updatedAt = new Date().toISOString();
          await store.saveGap(gap);
          const snapshot = await store.latestSnapshot(pairId);
          if (snapshot) {
            if (
              !gap.requirements.some(
                (r) => r.classification === "needs_investigation",
              )
            )
              snapshot.coverage.unprocessed =
                snapshot.coverage.unprocessed.filter(
                  (s) => s !== gap.integrationSha,
                );
            snapshot.coverage.assessed =
              snapshot.coverage.total - snapshot.coverage.unprocessed.length;
            await store.saveSnapshot(snapshot);
          }
          return gap;
        },
        async () => binding.targetPath,
        async () => {
          const snapshot = await store.latestSnapshot(pairId);
          return `You are the independent analyst. Read relevant docs and code in source checkout ${binding.sourcePath} at integration commit ${gap.integrationSha} and its first parent ${event.parent}; compare the final source commit ${snapshot.sourceSha} with frozen target commit ${snapshot.targetSha} in ${binding.targetPath}. Use Git objects at those SHAs; ignore uncommitted checkout edits. Inventory: ${JSON.stringify(event.files)}. First-parent diff: ${change?.diff || ""}. A different trigger branch or a separate pipeline file is not enough to classify a missing deploy variable or stage condition as no_target_impact. If a changed variable or condition is absent in the mapped target file, classify it as missing. A no_target_impact conclusion must name that same variable or condition in targetEvidence. Return only JSON {"requirements":[{"behavior":"short behavior title","classification":"missing|partial|present|no_target_impact|superseded|intentional_divergence|needs_investigation","rationale":"...","sourceEvidence":["file:line or commit"],"targetEvidence":["file:line or ref"],"dependencies":[],"featureArea":"...","groupKey":"stable semantic key","impact":"concrete target impact"}]}. Never call behavior present merely from commit ancestry. Use needs_investigation when uncertain. Do not modify files.`;
        },
      );
      return { jobId: job.id };
    },
  );
  app.post<{ Params: { pairId: string; gapId: string } }>(
    "/api/pairs/:pairId/gaps/:gapId/generate-plan",
    async (req) => {
      const { pairId, gapId } = req.params;
      const binding = (await store.binding()).pairs[pairId];
      const gap = await store.gap(pairId, gapId),
        pair = await store.pair(pairId);
      const job = agentJob(
        "plan",
        pairId,
        gapId,
        "planner",
        async (text) =>
          workflow.revisePlan(pairId, gapId, parseAgentJson(text)),
        async () => binding.targetPath,
        async () => {
          const snapshot = await store.latestSnapshot(pairId);
          return `You are the planner. Read only. Gap: ${JSON.stringify(gap)}. Frozen source SHA: ${snapshot.sourceSha}; target SHA: ${snapshot.targetSha}. Use Git objects at those SHAs; ignore uncommitted checkout edits. Pair rules: ${JSON.stringify(pair.rules)}. Mappings: ${JSON.stringify(pair.mappings)}. Return only JSON with keys sourceBehavior,targetBehavior,targetFiles (exact repository-relative paths),approach,conventions,dependencies,regressionTests,commands (array of {executable,args}),manualScenarios,questions. commands run inside the target worktree and must pass there. Put source-commit lookups in regressionTests, not commands. If ownership or implementation is unclear, list questions. Do not modify files.`;
        },
      );
      return { jobId: job.id };
    },
  );
  app.put<{ Params: { pairId: string; gapId: string } }>(
    "/api/pairs/:pairId/gaps/:gapId",
    async (req) =>
      workflow.updateEvidence(req.params.pairId, req.params.gapId, req.body),
  );
  const ensureIdle = (pairId: string, gapId: string) => {
    const active = jobs.activeLifecycle(pairId, gapId);
    if (active)
      throw new Error(
        `A ${active.kind} job is already ${active.status} for this gap. Open Activity and follow that job, or cancel it before starting another.`,
      );
  };
  app.post<{ Params: { pairId: string; gapId: string } }>(
    "/api/pairs/:pairId/gaps/:gapId/plan",
    async (req) =>
      workflow.revisePlan(
        req.params.pairId,
        req.params.gapId,
        z
          .object({
            sourceBehavior: z.string(),
            targetBehavior: z.string(),
            targetFiles: z.array(z.string()),
            approach: z.string(),
            conventions: z.array(z.string()),
            dependencies: z.array(z.string()),
            regressionTests: z.array(z.string()),
            commands: z.array(
              z.object({ executable: z.string(), args: z.array(z.string()) }),
            ),
            manualScenarios: z.array(z.string()),
            questions: z.array(planQuestionSchema),
          })
          .parse(req.body),
      ),
  );
  app.post<{
    Params: { pairId: string; gapId: string };
    Body: { approvedBy: string };
  }>("/api/pairs/:pairId/gaps/:gapId/approve", async (req) =>
    workflow.approve(req.params.pairId, req.params.gapId, req.body.approvedBy),
  );
  app.post<{ Params: { pairId: string; gapId: string } }>(
    "/api/pairs/:pairId/gaps/:gapId/implement",
    async (req) => {
      const { pairId, gapId } = req.params;
      ensureIdle(pairId, gapId);
      const gap = await store.gap(pairId, gapId);
      const latest = await store.latestRun(pairId, gapId);
      const retryable =
        gap.status === "implementing" &&
        (latest?.stage === "failed" || latest?.stage === "interrupted");
      if (gap.status !== "approved" && !retryable)
        throw new Error(
          "Approve the current plan before implementation. If a check already ran, open validation and run the checks again.",
        );
      await workflow.requireApproval(pairId, gapId);
      let run: Awaited<ReturnType<typeof workflow.createRun>>,
        plan: Awaited<ReturnType<typeof workflow.requireApproval>>["plan"];
      const job = agentJob(
        "implement",
        pairId,
        gapId,
        "implementer",
        async (_text, session) => {
          run.session = session;
          run.provider = selectedProvider(await store.binding());
          await workflow.checkScope(run, plan);
          run.status = "Implementation finished; run validation";
          run.updatedAt = new Date().toISOString();
          await store.saveRun(pairId, run);
          return run;
        },
        async () => run.worktree,
        async () => {
          ({ plan } = await workflow.requireApproval(pairId, gapId));
          run = await workflow.createRun(pairId, gapId);
          return `Implement exactly this approved plan in the current worktree. Do not commit, push, or modify files outside targetFiles. Plan: ${JSON.stringify(plan)}. Stop and ask before changing scope. Run only relevant checks; the workbench runs authoritative validation afterward.`;
        },
      );
      return { jobId: job.id };
    },
  );
  app.post<{ Params: { pairId: string; gapId: string } }>(
    "/api/pairs/:pairId/gaps/:gapId/open-worktree",
    async (req) => {
      const parsed = z
        .object({ editor: z.enum(["cursor", "code"]) })
        .strict()
        .safeParse(req.body);
      if (!parsed.success)
        throw new Error("Choose Cursor or VS Code to open the worktree.");
      const run = await store.latestRun(req.params.pairId, req.params.gapId);
      if (!run) throw new Error("No worktree yet. Start implementation first.");
      if (!existsSync(run.worktree))
        throw new Error(
          "Worktree folder is missing. Retry implementation to recreate it.",
        );
      return openWorktree(parsed.data.editor, run.worktree);
    },
  );
  app.post<{ Params: { pairId: string; gapId: string } }>(
    "/api/pairs/:pairId/gaps/:gapId/validate",
    async (req) => {
      const { pairId, gapId } = req.params;
      ensureIdle(pairId, gapId);
      const job = jobs.enqueue("validate", pairId, gapId, async (current) => {
        const other = jobs.activeLifecycle(pairId, gapId, current.id);
        if (other)
          throw new Error(
            `A ${other.kind} job is already ${other.status} for this gap. Open Activity and follow that job, or cancel it before starting another.`,
          );
        return workflow.validate(pairId, gapId, current.abort.signal, {
          onProgress: (progress) =>
            jobs.emit(
              current,
              "validation-progress",
              validationMilestone(progress),
            ),
          onActivity: (activity) =>
            jobs.emit(current, "validation-heartbeat", {
              activity: "heartbeat",
              index: activity.index,
              name: activity.name,
              lastOutputAt: activity.lastOutputAt,
            }),
        });
      });
      return { jobId: job.id };
    },
  );
  app.post<{
    Params: { pairId: string; gapId: string };
    Body: { scenario: string; status: "passed" | "failed"; notes: string };
  }>("/api/pairs/:pairId/gaps/:gapId/manual", async (req) =>
    workflow.recordManual(
      req.params.pairId,
      req.params.gapId,
      req.body.scenario,
      req.body.status,
      req.body.notes,
    ),
  );
  app.post<{ Params: { pairId: string; gapId: string } }>(
    "/api/pairs/:pairId/gaps/:gapId/review",
    async (req) => {
      const { pairId, gapId } = req.params;
      ensureIdle(pairId, gapId);
      const { plan } = await workflow.requireApproval(pairId, gapId),
        run = await store.latestRun(pairId, gapId),
        gap = await store.gap(pairId, gapId);
      if (!run || run.stage !== "reviewing")
        throw new Error(
          "Validation must pass before review. Finish the required checks, then start review again.",
        );
      const diff = await completeDiff(run.worktree, run.baseSha);
      const job = agentJob(
        "review",
        pairId,
        gapId,
        "reviewer",
        async (text) => {
          const result = z
            .object({
              verdict: z.enum(["approved", "changes_requested"]),
              findings: z.array(z.string()),
            })
            .parse(parseAgentJson(text));
          const current = await store.latestRun(pairId, gapId);
          if (!current || current.stage !== "reviewing")
            throw new Error(
              "Validation must pass before review. Finish the required checks, then start review again.",
            );
          return workflow.recordReview(
            pairId,
            gapId,
            result.verdict,
            result.findings,
          );
        },
        async () => run.worktree,
        async () =>
          `You are a fresh independent reviewer. Read only. Review source requirements ${JSON.stringify(gap.requirements)}, approved plan ${JSON.stringify(plan)}, validation ${JSON.stringify(run.checks)}, and actual complete diff:\n${diff}\nCheck behavior, target conventions, unintended changes, and meaningful tests. Return only JSON {"verdict":"approved|changes_requested","findings":["..."]}. Do not modify files.`,
        async () => {
          const current = await store.latestRun(pairId, gapId);
          if (!current || current.stage !== "reviewing")
            throw new Error(
              "Validation must pass before review. Finish the required checks, then start review again.",
            );
        },
      );
      return { jobId: job.id };
    },
  );
  app.post<{
    Params: { pairId: string; gapId: string };
    Body: { integratedSha: string; evidence: string[] };
  }>("/api/pairs/:pairId/gaps/:gapId/integrate", async (req) => {
    const { pairId, gapId } = req.params;
    const job = jobs.enqueue("integrate", pairId, gapId, async () =>
      workflow.confirmIntegration(
        pairId,
        gapId,
        req.body.integratedSha,
        req.body.evidence,
      ),
    );
    return { jobId: job.id };
  });
  app.post<{
    Params: { pairId: string; gapId: string };
    Body: { decidedBy: string; reason: string };
  }>("/api/pairs/:pairId/gaps/:gapId/resolve-no-action", async (req) =>
    workflow.resolveNoAction(
      req.params.pairId,
      req.params.gapId,
      req.body.decidedBy,
      req.body.reason,
    ),
  );
  app.get<{ Params: { pairId: string; gapId: string } }>(
    "/api/pairs/:pairId/gaps/:gapId/diff",
    async (req) => {
      const run = await store.latestRun(req.params.pairId, req.params.gapId);
      if (!run) return { diff: "" };
      return {
        diff: await completeDiff(run.worktree, run.baseSha),
        fingerprint: await diffFingerprint(run.worktree, run.baseSha),
      };
    },
  );
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req) => {
    const job = jobs.all.get(req.params.id);
    if (!job) throw new Error("Job not found");
    return jobs.visible(job);
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req) => {
    const { abort, ...visible } = jobs.cancel(req.params.id);
    return visible;
  });
  app.post<{ Params: { id: string; interactionId: string } }>(
    "/api/jobs/:id/interactions/:interactionId",
    async (req) => {
      const { abort, ...visible } = jobs.answer(
        req.params.id,
        req.params.interactionId,
        (req.body as { value: unknown }).value,
      );
      return visible;
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id/events",
    async (req, reply) => {
      const job = jobs.all.get(req.params.id);
      if (!job) throw new Error("Job not found");
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const terminal = () =>
        ["done", "failed", "cancelled"].includes(job.status);
      const send = (type: string, value: unknown) =>
        reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      const cleanup = () => jobs.emitter.off(job.id, listener);
      const listener = (update: { event: { type: string } }) => {
        send("update", update);
        if (terminal()) {
          cleanup();
          reply.raw.end();
        }
      };
      jobs.emitter.on(job.id, listener);
      req.raw.on("close", cleanup);
      send("snapshot", jobs.visible(job));
      if (terminal()) {
        cleanup();
        reply.raw.end();
      }
    },
  );
  const web = path.resolve(root, "packages/web/dist");
  if (existsSync(web)) {
    app.register(fastifyStatic, { root: web, prefix: "/" });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.sendFile("index.html"),
    );
  }
  return { app, store, workflow, jobs };
}
