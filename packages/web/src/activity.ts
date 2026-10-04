import type { JobEvent } from "./types.js";

export type TimelineEntry = {
  at: string;
  summary: string;
  count: number;
  recovery?: string;
};
export type CheckProgress = {
  index: number;
  total: number;
  name: string;
  phase: "pending" | "running" | "passed" | "failed" | "reused";
  completed: number;
  blocking: boolean;
};

const knownSummary = (event: JobEvent) => {
  if (event.type === "queued") return "Added to the queue";
  if (event.type === "started") return "Started";
  if (event.type === "interaction") return "Waiting for your response";
  if (event.type === "interaction-resolved") return "Response sent";
  if (event.type === "done") return "Completed";
  if (event.type === "failed") return "Failed";
  if (event.type === "cancelled") return "Cancelled";
  if (event.type === "interrupted") return "Interrupted by a backend restart";
  return undefined;
};

export function timelineEntries(events: readonly JobEvent[]): TimelineEntry[] {
  const rows: TimelineEntry[] = [];
  for (const event of events) {
    if (
      event.type === "text" ||
      event.type === "technical" ||
      event.type === "validation-heartbeat"
    )
      continue;
    const data =
      event.data && typeof event.data === "object"
        ? (event.data as {
            activity?: string;
            summary?: unknown;
            recovery?: unknown;
          })
        : undefined;
    if (data?.activity === "technical" || data?.activity === "heartbeat")
      continue;
    const summary =
      typeof data?.summary === "string" && data.summary.trim()
        ? data.summary.trim()
        : knownSummary(event);
    if (!summary || /session\/update|session · update/i.test(summary)) continue;
    const recovery =
      typeof data?.recovery === "string" ? data.recovery : undefined;
    const last = rows[rows.length - 1];
    if (last && last.summary === summary) {
      last.count += 1;
      last.at = event.at;
      if (recovery) last.recovery = recovery;
      continue;
    }
    rows.push({ at: event.at, summary, count: 1, recovery });
  }
  return rows;
}

export function validationSnapshot(events: readonly JobEvent[]) {
  let progress: CheckProgress | undefined;
  let runningSince: string | undefined;
  let lastOutputAt: string | undefined;
  for (const event of events) {
    const data =
      event.data && typeof event.data === "object"
        ? (event.data as {
            progress?: CheckProgress;
            index?: number;
            lastOutputAt?: string;
          })
        : undefined;
    if (!data) continue;
    if (event.type === "validation-progress" && data.progress) {
      progress = data.progress;
      if (data.progress.phase === "running") runningSince = event.at;
      if (data.progress.phase === "passed" || data.progress.phase === "failed" || data.progress.phase === "reused")
        runningSince = undefined;
    }
    if (
      (event.type === "validation-heartbeat" || data.lastOutputAt) &&
      data.lastOutputAt &&
      (progress === undefined || data.index === undefined || data.index === progress.index)
    )
      lastOutputAt = data.lastOutputAt;
  }
  return { progress, runningSince, lastOutputAt };
}

export function formatElapsed(totalSeconds: number) {
  const seconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

export function jobObjectiveText(kind: string) {
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

export function connectionCopy(
  connection: string,
  job?: { status?: string; error?: string },
) {
  if (job?.status === "cancelled")
    return "Cancelled. Review the worktree before starting again.";
  if (job?.error?.includes("Interrupted by backend"))
    return "The backend restarted. Inspect the worktree and approval, then retry.";
  if (job?.status === "failed")
    return "The job failed. Read the error, fix the cause, and run it again.";
  if (connection === "reconnecting")
    return "Reconnecting to job updates. Work on the server continues.";
  if (connection === "connecting") return "Connecting to job updates.";
  return "Connected";
}

export const quietAfterMs = 20_000;
export function quietCopy(running: boolean, lastOutputAt: string | undefined, now: number) {
  if (!running) return "";
  if (!lastOutputAt || now - Date.parse(lastOutputAt) >= quietAfterMs)
    return "This check is still running. No recent output does not mean it has stopped.";
  return "";
}
