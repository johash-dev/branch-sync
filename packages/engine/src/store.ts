import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  approvalSchema,
  gapSchema,
  integrationSchema,
  localBindingSchema,
  pairConfigSchema,
  planSchema,
  runSchema,
  snapshotSchema,
  type Approval,
  type GapRecord,
  type IntegrationRecord,
  type LocalBinding,
  type PairConfig,
  type PlanRevision,
  type RunRecord,
  type AnalysisSnapshot,
} from "./schema.js";
import {
  git,
  integrationEvents,
  isAncestor,
  resolveCommit,
  verifyPair,
} from "./git.js";

export const hash = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
const now = () => new Date().toISOString();
async function readJson<T>(
  file: string,
  schema: { parse(v: unknown): T },
): Promise<T> {
  return schema.parse(JSON.parse(await readFile(file, "utf8")));
}
async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n");
  await rename(temp, file);
}
async function listJson<T>(
  dir: string,
  schema: { parse(v: unknown): T },
): Promise<T[]> {
  try {
    return await Promise.all(
      (await readdir(dir))
        .filter((x) => x.endsWith(".json"))
        .map((x) => readJson(path.join(dir, x), schema)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export class Store {
  constructor(readonly root: string) {}
  private shared(...parts: string[]) {
    return path.join(this.root, "data", ...parts);
  }
  private local(...parts: string[]) {
    return path.join(this.root, ".local", ...parts);
  }
  async binding(): Promise<LocalBinding> {
    try {
      return await readJson(this.local("bindings.json"), localBindingSchema);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, pairs: {}, defaultProvider: "codex" };
      throw error;
    }
  }
  async saveBinding(binding: LocalBinding) {
    await atomicJson(
      this.local("bindings.json"),
      localBindingSchema.parse(binding),
    );
  }
  async pairs() {
    return listJson(this.shared("pairs"), pairConfigSchema);
  }
  async pair(id: string) {
    return readJson(this.shared("pairs", `${id}.json`), pairConfigSchema);
  }
  async savePair(value: PairConfig) {
    const pair = pairConfigSchema.parse(value);
    const previous = await this.pair(pair.id).catch(() => null);
    await atomicJson(this.shared("pairs", `${pair.id}.json`), pair);
    if (previous && hash(previous) !== hash(pair))
      await this.invalidatePair(pair.id);
  }
  async invalidatePair(pairId: string) {
    for (const gap of await this.gaps(pairId))
      if (gap.status !== "integrated") {
        gap.status = "open";
        gap.noActionResolution = undefined;
        gap.updatedAt = now();
        await this.saveGap(gap);
      }
  }
  async snapshots(pairId: string) {
    return listJson(this.shared("snapshots", pairId), snapshotSchema);
  }
  async snapshot(pairId: string, id: string) {
    return readJson(
      this.shared("snapshots", pairId, `${id}.json`),
      snapshotSchema,
    );
  }
  async latestSnapshot(pairId: string) {
    return (await this.snapshots(pairId)).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0];
  }
  async saveSnapshot(value: AnalysisSnapshot) {
    const snapshot = snapshotSchema.parse(value);
    await atomicJson(
      this.shared("snapshots", snapshot.pairId, `${snapshot.id}.json`),
      snapshot,
    );
  }
  async writeReport(snapshot: AnalysisSnapshot) {
    const lines = [
      `# Analysis: ${snapshot.pairId}`,
      ``,
      `- Scanned: ${snapshot.createdAt}`,
      `- Mode: ${snapshot.offline ? "offline (cached refs)" : "fetched"}`,
      `- Source: \`${snapshot.sourceSha}\``,
      `- Target: \`${snapshot.targetSha}\``,
      `- Baseline: \`${snapshot.baselineSha}\``,
      `- Integration events: ${snapshot.events.length}`,
      `- Unprocessed: ${snapshot.coverage.unprocessed.length}`,
      ``,
    ];
    if (snapshot.events.length === 0)
      lines.push(
        "No source changes after baseline. This does not establish complete migration parity.",
        "",
      );
    for (const event of snapshot.events)
      lines.push(
        `## ${event.sha.slice(0, 12)} ${event.subject}`,
        ``,
        `- First parent: \`${event.parent}\``,
        `- Files: ${event.files.length}`,
        `- Empty diff: ${event.empty}`,
        ``,
        ...event.files.map((file) => `- ${file.status} \`${file.path}\``),
        ``,
      );
    const file = this.shared("reports", snapshot.pairId, `${snapshot.id}.md`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, lines.join("\n"));
  }
  async gaps(pairId: string) {
    return listJson(this.shared("gaps", pairId), gapSchema);
  }
  async gap(pairId: string, id: string) {
    return readJson(this.shared("gaps", pairId, `${id}.json`), gapSchema);
  }
  async saveGap(value: GapRecord) {
    const gap = gapSchema.parse(value);
    await atomicJson(this.shared("gaps", gap.pairId, `${gap.id}.json`), gap);
  }
  async plans(pairId: string, gapId: string) {
    return listJson(this.shared("plans", pairId, gapId), planSchema);
  }
  async latestPlan(pairId: string, gapId: string) {
    return (await this.plans(pairId, gapId)).sort(
      (a, b) => b.revision - a.revision,
    )[0];
  }
  async savePlan(pairId: string, value: PlanRevision) {
    const plan = planSchema.parse(value);
    await atomicJson(
      this.shared("plans", pairId, plan.gapId, `${plan.id}.json`),
      plan,
    );
  }
  async approval(pairId: string, gapId: string): Promise<Approval | undefined> {
    return (
      await listJson(this.shared("approvals", pairId, gapId), approvalSchema)
    ).sort((a, b) => b.approvedAt.localeCompare(a.approvedAt))[0];
  }
  async saveApproval(pairId: string, value: Approval) {
    const approval = approvalSchema.parse(value);
    await atomicJson(
      this.shared(
        "approvals",
        pairId,
        approval.gapId,
        `${approval.approvedAt.replace(/[:.]/g, "-")}.json`,
      ),
      approval,
    );
  }
  async runs(pairId: string, gapId: string) {
    return listJson(this.local("runs", pairId, gapId), runSchema);
  }
  async latestRun(pairId: string, gapId: string) {
    return (await this.runs(pairId, gapId)).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0];
  }
  async saveRun(pairId: string, value: RunRecord) {
    const run = runSchema.parse(value);
    await atomicJson(
      this.local("runs", pairId, run.gapId, `${run.id}.json`),
      run,
    );
  }
  async saveIntegration(pairId: string, value: IntegrationRecord) {
    const record = integrationSchema.parse(value);
    await atomicJson(
      this.shared("integrations", pairId, `${record.gapId}.json`),
      record,
    );
  }
  async integrations(pairId: string) {
    return listJson(this.shared("integrations", pairId), integrationSchema);
  }
  async scan(pairId: string, offline: boolean): Promise<AnalysisSnapshot> {
    const pair = await this.pair(pairId);
    const binding = (await this.binding()).pairs[pairId];
    if (!binding)
      throw new Error(`Pair ${pairId} needs local repository paths`);
    if (!offline) {
      await git(binding.sourcePath, "fetch", pair.source.remote);
      if (
        (await git(
          binding.sourcePath,
          "rev-parse",
          "--is-shallow-repository",
        )) === "true" &&
        !(await resolveCommit(binding.sourcePath, pair.baseline).then(
          () => true,
          () => false,
        ))
      )
        await git(
          binding.sourcePath,
          "fetch",
          "--unshallow",
          pair.source.remote,
        );
      if (
        binding.sourcePath !== binding.targetPath ||
        pair.source.remote !== pair.target.remote
      )
        await git(binding.targetPath, "fetch", pair.target.remote);
    }
    const verified = await verifyPair(
      pair,
      binding.sourcePath,
      binding.targetPath,
    );
    const events = await integrationEvents(
      binding.sourcePath,
      verified.baselineSha,
      verified.sourceSha,
    );
    const knowledgeHash = hash({
      rules: pair.rules,
      mappings: pair.mappings,
      intentionalDifferences: pair.intentionalDifferences,
    });
    const configHash = hash(pair);
    const previous = await this.latestSnapshot(pairId);
    const sameEvidence =
      previous?.sourceSha === verified.sourceSha &&
      previous?.targetSha === verified.targetSha &&
      previous?.configHash === configHash;
    const integrations = new Map(
      (await this.integrations(pairId)).map((record) => [record.gapId, record]),
    );
    const reopenReasons = new Map<string, string>();
    for (const gap of await this.gaps(pairId)) {
      if (gap.status !== "integrated") continue;
      const record = integrations.get(gap.id);
      if (!record) {
        reopenReasons.set(gap.id, "Integration evidence is missing");
        continue;
      }
      if (
        !(await isAncestor(
          binding.targetPath,
          record.integratedSha,
          verified.targetSha,
        ).catch(() => false))
      ) {
        reopenReasons.set(
          gap.id,
          "Integrated commit is no longer reachable from target",
        );
        continue;
      }
      if (
        previous?.configHash !== configHash ||
        previous?.sourceSha !== verified.sourceSha
      ) {
        reopenReasons.set(
          gap.id,
          "Source or pair configuration changed after integration",
        );
        continue;
      }
      if (verified.targetSha !== record.observedTargetSha) {
        if (!record.reviewedFiles.length) {
          reopenReasons.set(
            gap.id,
            "Target advanced and reviewed file evidence is unavailable",
          );
          continue;
        }
        for (const file of record.reviewedFiles) {
          const currentBlob = await git(
            binding.targetPath,
            "rev-parse",
            `${verified.targetSha}:${file.path}`,
          ).catch(() => null);
          if (currentBlob !== file.blob) {
            reopenReasons.set(
              gap.id,
              `Reviewed target file changed: ${file.path}`,
            );
            break;
          }
        }
      }
    }
    const unprocessed: string[] = [];
    for (const event of events) {
      const existing = await this.gap(pairId, `${pairId}-${event.sha}`).catch(
        () => null,
      );
      if (
        !sameEvidence ||
        reopenReasons.has(`${pairId}-${event.sha}`) ||
        !existing ||
        (existing.status === "open" &&
          existing.requirements.some(
            (r) => r.classification === "needs_investigation",
          )) ||
        (existing.status === "open" &&
          existing.requirements.some((r) => !r.groupKey))
      )
        unprocessed.push(event.sha);
    }
    const snapshot: AnalysisSnapshot = {
      version: 1,
      id: randomUUID(),
      pairId,
      createdAt: now(),
      sourceSha: verified.sourceSha,
      targetSha: verified.targetSha,
      baselineSha: verified.baselineSha,
      fetchedAt: offline ? null : now(),
      offline,
      knowledgeHash,
      configHash,
      events,
      coverage: {
        total: events.length,
        assessed: events.length - unprocessed.length,
        unprocessed,
      },
    };
    await this.saveSnapshot(snapshot);
    await this.writeReport(snapshot);
    for (const event of events) {
      const gapId = `${pairId}-${event.sha}`;
      const existing = await this.gap(pairId, gapId).catch(() => null);
      if (existing) {
        const reopenReason = reopenReasons.get(gapId);
        if (
          reopenReason ||
          (!sameEvidence && existing.status !== "integrated")
        ) {
          existing.status = "open";
          existing.noActionResolution = undefined;
          existing.snapshotId = snapshot.id;
          existing.requirements = existing.requirements.map((r) => ({
            ...r,
            classification: "needs_investigation" as const,
            rationale:
              reopenReason ||
              "Source, target, or knowledge changed; reassessment required",
          }));
          existing.updatedAt = now();
          await this.saveGap(existing);
        }
        continue;
      }
      await this.saveGap({
        version: 1,
        id: gapId,
        pairId,
        integrationSha: event.sha,
        sourceSubject: event.subject,
        snapshotId: snapshot.id,
        requirements: [
          {
            id: `${gapId}-1`,
            behavior: event.subject || "Empty integration event",
            classification: event.empty
              ? "no_target_impact"
              : "needs_investigation",
            rationale: event.empty
              ? "Integration diff against first parent is empty; confirm no behavior changed"
              : "Git history alone cannot establish target behavior",
            sourceEvidence: event.empty
              ? [`git diff ${event.parent}..${event.sha}: empty`]
              : event.files.map((f) => `${f.status} ${f.path}`),
            targetEvidence: event.empty
              ? ["No target comparison required for an empty integration diff"]
              : [],
            dependencies: [],
            featureArea: "unassigned",
            groupKey: "",
            impact: "",
          },
        ],
        status: "open",
        updatedAt: now(),
      });
    }
    return snapshot;
  }
}
