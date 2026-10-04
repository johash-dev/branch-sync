import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type ActivityName =
  | "queued"
  | "phase"
  | "operation"
  | "waiting"
  | "progress"
  | "heartbeat"
  | "outcome"
  | "technical";
export type Job = {
  id: string;
  kind: string;
  pairId: string;
  gapId?: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  events: { at: string; type: string; data: unknown }[];
  interactions: { id: string; type: string; params: unknown }[];
  result?: unknown;
  error?: string;
  abort: AbortController;
};
export const lifecycleKinds = ["implement", "validate", "review"] as const;
const jobNames: Record<string, string> = {
  implement: "Implementation",
  validate: "Validation",
  review: "Review",
  analyze: "Analysis",
  plan: "Planning",
  assess: "Assessment",
  integrate: "Integration",
};
export function jobObjective(kind: string) {
  switch (kind) {
    case "implement":
      return "Implement the approved plan in a worktree";
    case "validate":
      return "Run the validation checks";
    case "review":
      return "Review the diff against the saved plan";
    case "analyze":
      return "Analyze source and target changes";
    case "plan":
      return "Draft an adaptation plan";
    case "assess":
      return "Assess the source change";
    case "integrate":
      return "Confirm the change is on the target branch";
    default:
      return "Run the requested work";
  }
}
export function jobPhaseSummary(
  kind: string,
  phase: "queued" | "started" | "done" | "failed" | "cancelled",
) {
  const name = jobNames[kind] || "Job";
  if (phase === "queued") return `${name} queued`;
  if (phase === "started") return `${name} started`;
  if (phase === "done") return `${name} finished`;
  if (phase === "failed") return `${name} failed`;
  return `${name} cancelled`;
}
export function waitingSummary(type: string, params: unknown) {
  const record =
    params && typeof params === "object"
      ? (params as Record<string, unknown>)
      : {};
  const command = String(
    record.command || record.title || record.tool_name || "",
  );
  const permission =
    type.includes("permission") ||
    type.includes("requestApproval") ||
    type === "claude/permission";
  if (permission) {
    if (/test/i.test(command)) return "Waiting for permission to run tests";
    if (command.trim())
      return `Waiting for permission to run ${command.trim().slice(0, 80)}`;
    return "Waiting for permission to continue";
  }
  if (type === "cursor/create_plan")
    return "Waiting for agent execution consent";
  if (type.includes("question") || type === "cursor/ask_question")
    return "Waiting for your answer";
  return "Waiting for you to continue";
}
function failedCheckCount(result: unknown) {
  const checks = (result as { checks?: { status?: string }[] } | undefined)
    ?.checks;
  if (!Array.isArray(checks)) return 0;
  return checks.filter((check) => check.status === "failed").length;
}
export function outcomeSummary(job: {
  kind: string;
  status: Job["status"];
  result?: unknown;
  error?: string;
}) {
  if (job.status === "cancelled")
    return {
      summary: jobPhaseSummary(job.kind, "cancelled"),
      recovery: "Start the action again when you are ready.",
    };
  if (job.status === "failed") {
    const failed = failedCheckCount(job.result);
    return {
      summary:
        job.kind === "validate" && failed
          ? `Validation finished with ${failed} failed ${failed === 1 ? "check" : "checks"}`
          : jobPhaseSummary(job.kind, "failed"),
      recovery: job.error?.includes("Interrupted by backend")
        ? "Inspect the worktree and approval, then retry."
        : "Read the error, fix the cause, and run the action again.",
    };
  }
  if (job.kind === "validate") {
    const failed = failedCheckCount(job.result);
    const stage = (job.result as { stage?: string } | undefined)?.stage;
    if (failed)
      return {
        summary: `Validation finished with ${failed} failed ${failed === 1 ? "check" : "checks"}`,
        recovery: "Fix the failed checks and run validation again.",
      };
    if (stage === "validating")
      return {
        summary:
          "Validation finished the automated checks. Record an observed result for each manual scenario.",
        recovery: "Open Validate and record what you observed.",
      };
  }
  if (job.kind === "implement")
    return {
      summary: "Implementation finished",
      recovery: "Open Validate and run the required checks.",
    };
  if (job.kind === "review")
    return {
      summary: "Review finished",
      recovery: "Read the findings, then continue with handoff or another edit.",
    };
  return { summary: jobPhaseSummary(job.kind, "done") };
}
export class Jobs {
  readonly all = new Map<string, Job>();
  readonly emitter = new EventEmitter();
  private queue: { job: Job; work: (job: Job) => Promise<unknown> }[] = [];
  private answers = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private busy = false;
  private writes = new Map<string, Promise<void>>();
  constructor(private root: string) {}
  visible(job: Job) {
    const { abort, ...visible } = job;
    return visible;
  }
  state(job: Job) {
    const { events, abort, ...state } = job;
    return state;
  }
  private file(id: string) {
    return path.join(this.root, ".local", "jobs", `${id}.json`);
  }
  async recover() {
    const dir = path.dirname(this.file("x"));
    await mkdir(dir, { recursive: true });
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await readFile(path.join(dir, name), "utf8"));
        const job: Job = {
          ...raw,
          abort: new AbortController(),
          interactions: [],
        };
        if (job.status === "running" || job.status === "queued") {
          job.status = "failed";
          job.error =
            "Interrupted by backend restart; inspect worktree and approval before retrying";
          job.events.push({
            at: new Date().toISOString(),
            type: "interrupted",
            data: {
              error: job.error,
              activity: "outcome",
              summary: "Interrupted by a backend restart",
              recovery: "Inspect the worktree and approval, then retry.",
            },
          });
        }
        this.all.set(job.id, job);
        await this.persist(job);
      } catch {}
    }
  }
  private persist(job: Job) {
    const previous = this.writes.get(job.id) || Promise.resolve();
    const next = previous.then(async () => {
      const file = this.file(job.id),
        temp = `${file}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(file), { recursive: true });
      const { abort, ...visible } = job;
      await writeFile(temp, JSON.stringify(visible, null, 2));
      await rename(temp, file);
    });
    this.writes.set(
      job.id,
      next.catch(() => {}),
    );
    return next;
  }
  enqueue(
    kind: string,
    pairId: string,
    gapId: string | undefined,
    work: (job: Job) => Promise<unknown>,
  ) {
    const job: Job = {
      id: randomUUID(),
      kind,
      pairId,
      gapId,
      status: "queued",
      events: [],
      interactions: [],
      abort: new AbortController(),
    };
    this.all.set(job.id, job);
    this.queue.push({ job, work });
    this.emit(job, "queued", {
      kind,
      activity: "queued",
      summary: jobPhaseSummary(kind, "queued"),
      objective: jobObjective(kind),
    });
    void this.drain();
    return job;
  }
  activeLifecycle(pairId: string, gapId: string, exceptId?: string) {
    for (const job of this.all.values()) {
      if (exceptId && job.id === exceptId) continue;
      if (job.pairId !== pairId || job.gapId !== gapId) continue;
      if (!(lifecycleKinds as readonly string[]).includes(job.kind)) continue;
      if (job.status === "queued" || job.status === "running") return job;
    }
  }
  emit(job: Job, type: string, data: unknown) {
    const event = { at: new Date().toISOString(), type, data };
    job.events.push(event);
    this.emitter.emit(job.id, {
      seq: job.events.length,
      event,
      state: this.state(job),
    });
    void this.persist(job).catch((error) => {
      console.error(`Failed to persist job ${job.id}:`, error);
    });
  }
  ask(job: Job, type: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    const interaction = { id, type, params };
    job.interactions.push(interaction);
    this.emit(job, "interaction", {
      ...interaction,
      activity: "waiting",
      summary: waitingSummary(type, params),
    });
    return new Promise((resolve, reject) => {
      this.answers.set(id, { resolve, reject });
      job.abort.signal.addEventListener(
        "abort",
        () => {
          this.answers.delete(id);
          reject(new Error("Cancelled"));
        },
        { once: true },
      );
    });
  }
  answer(jobId: string, id: string, value: unknown) {
    const job = this.all.get(jobId);
    if (!job) throw new Error("Job not found");
    const pending = this.answers.get(id);
    if (!pending || !job.interactions.some((x) => x.id === id))
      throw new Error("Interaction not pending");
    this.answers.delete(id);
    job.interactions = job.interactions.filter((x) => x.id !== id);
    pending.resolve(value);
    this.emit(job, "interaction-resolved", { id });
    return job;
  }
  cancel(id: string) {
    const job = this.all.get(id);
    if (!job) throw new Error("Job not found");
    job.abort.abort();
    if (job.status === "queued") {
      job.status = "cancelled";
      this.queue = this.queue.filter((x) => x.job.id !== id);
      const outcome = outcomeSummary(job);
      this.emit(job, "cancelled", { activity: "outcome", ...outcome });
    }
    return job;
  }
  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const { job, work } = this.queue.shift()!;
        if (job.status === "cancelled") continue;
        job.status = "running";
        this.emit(job, "started", {
          activity: "phase",
          summary: jobPhaseSummary(job.kind, "started"),
          objective: jobObjective(job.kind),
        });
        try {
          job.result = await work(job);
          job.status = job.abort.signal.aborted ? "cancelled" : "done";
          const outcome = outcomeSummary(job);
          this.emit(job, job.status, {
            activity: "outcome",
            ...outcome,
            result: job.result,
          });
        } catch (error) {
          job.status = job.abort.signal.aborted ? "cancelled" : "failed";
          job.error = String(error);
          const outcome = outcomeSummary(job);
          this.emit(job, job.status, {
            activity: "outcome",
            error: job.error,
            ...outcome,
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
