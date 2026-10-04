import { z } from "zod";
import type { AnalysisSnapshot, PairConfig } from "@sync/engine";
import { Store, git } from "@sync/engine";
import { extractAgentJson } from "./agent-json.js";

const genericPipelineTokens = new Set([
  "true",
  "false",
  "and",
  "or",
  "eq",
  "ne",
  "not",
  "succeeded",
  "failed",
  "condition",
  "variables",
  "contains",
  "in",
  "coalesce",
  "format",
]);

export type EventChange = { diff: string; symbols: string[] };

const classificationNames = [
  "missing",
  "partial",
  "present",
  "no_target_impact",
  "superseded",
  "intentional_divergence",
  "needs_investigation",
] as const;

export function changedSymbols(diff: string) {
  const added = new Set<string>();
  const removed = new Set<string>();
  const collect = (line: string, into: Set<string>) => {
    const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (key && !genericPipelineTokens.has(key[1])) into.add(key[1]);
    for (const match of line.matchAll(
      /variables\[\s*['"]([^'"]+)['"]\s*\]/g,
    )) {
      const name = match[1].split(".").pop() || match[1];
      if (!genericPipelineTokens.has(name)) into.add(name);
    }
    if (/condition\s*:/.test(line)) {
      for (const match of line.matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
        if (!genericPipelineTokens.has(match[1])) into.add(match[1]);
      }
    }
  };
  for (const line of diff.split(/\r?\n/)) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ")
    )
      continue;
    if (line.startsWith("+")) collect(line.slice(1), added);
    else if (line.startsWith("-")) collect(line.slice(1), removed);
  }
  return [...added].filter((symbol) => !removed.has(symbol)).sort();
}

export function compactDiff(diff: string, limit = 6000) {
  if (diff.length <= limit) return diff;
  const kept = diff.slice(0, limit);
  const priority = diff.split(/\r?\n/).filter(
    (line) =>
      /^(\+\+\+|---|diff |@@)/.test(line) ||
      /^[+-](?![+-]).*(condition:|variables\[|[A-Za-z_][A-Za-z0-9_]*\s*:)/.test(
        line,
      ),
  );
  const rest = priority.filter((line) => !kept.includes(line));
  return rest.length
    ? `${kept}\n...[diff truncated; remaining variable and condition lines]\n${rest.join("\n")}`
    : `${kept}\n...[diff truncated]`;
}

export async function eventChanges(
  sourcePath: string,
  events: Array<{
    sha: string;
    parent: string;
    files: { path: string }[];
    empty: boolean;
  }>,
) {
  const changes = new Map<string, EventChange>();
  for (const event of events) {
    if (event.empty || !event.files.length) {
      changes.set(event.sha, { diff: "", symbols: [] });
      continue;
    }
    const raw = await git(
      sourcePath,
      "diff",
      "--unified=3",
      event.parent,
      event.sha,
      "--",
      ...event.files.map((file) => file.path),
    );
    changes.set(event.sha, {
      diff: compactDiff(raw),
      symbols: changedSymbols(raw),
    });
  }
  return changes;
}

export function guardRequirement(
  requirement: {
    classification: (typeof classificationNames)[number];
    rationale: string;
    sourceEvidence: string[];
    targetEvidence: string[];
  },
  options: { intentionalDecision?: unknown; symbols?: string[] },
) {
  const symbols = options.symbols ?? [];
  const layoutOnly =
    requirement.classification === "no_target_impact" &&
    symbols.length > 0 &&
    !symbols.some((symbol) =>
      requirement.targetEvidence.join("\n").includes(symbol),
    );
  if (
    !requirement.sourceEvidence.some(Boolean) ||
    !requirement.targetEvidence.some(Boolean) ||
    (requirement.classification === "intentional_divergence" &&
      !options.intentionalDecision) ||
    layoutOnly
  )
    return {
      classification: "needs_investigation" as const,
      rationale: layoutOnly
        ? `${requirement.rationale} Target evidence does not mention the changed symbol or condition (${symbols.join(", ")}).`
        : requirement.rationale,
    };
  return {
    classification: requirement.classification,
    rationale: requirement.rationale,
  };
}

const proposalSchema = z.object({
  events: z.array(
    z.object({
      sha: z.string(),
      requirements: z
        .array(
          z.object({
            behavior: z.string().min(1),
            classification: z.enum([
              "missing",
              "partial",
              "present",
              "no_target_impact",
              "superseded",
              "intentional_divergence",
              "needs_investigation",
            ]),
            rationale: z.string().min(1),
            sourceEvidence: z.array(z.string()),
            targetEvidence: z.array(z.string()),
            dependencies: z.array(z.string()).default([]),
            featureArea: z.string().default("unassigned"),
            groupKey: z.string().min(1),
            impact: z.string().min(1),
          }),
        )
        .min(1),
    }),
  ),
});

export function assessmentPrompt(
  pair: PairConfig,
  snapshot: AnalysisSnapshot,
  sourcePath: string,
  targetPath: string,
  changes: ReadonlyMap<string, EventChange> = new Map(),
) {
  const pending = snapshot.events.filter((event) =>
    snapshot.coverage.unprocessed.includes(event.sha),
  );
  return `You are the independent porting analyst. Decide which source behaviors or fixes need adaptation in the target. Read relevant project documentation and code in both repositories, including architecture and migration guidance. Compare Git objects at the frozen commits, never uncommitted edits. Source checkout: ${sourcePath}, final source commit: ${snapshot.sourceSha}. Target checkout: ${targetPath}, target commit: ${snapshot.targetSha}. Pair rules: ${JSON.stringify(pair.rules)}. Mappings: ${JSON.stringify(pair.mappings)}. Intentional differences: ${JSON.stringify(pair.intentionalDifferences)}. Integration events to assess: ${JSON.stringify(pending.map((event) => ({ sha: event.sha, parent: event.parent, subject: event.subject, constituentCommits: event.constituentCommits, files: event.files, diff: changes.get(event.sha)?.diff || "" })))}.

Each event includes its first-parent diff. A different trigger branch or a separate pipeline file is not enough to classify a missing deploy variable or stage condition as no_target_impact. If a changed variable or condition from the diff is absent in the mapped target file, classify that behavior as missing and quote the variable or condition in sourceEvidence. A no_target_impact conclusion must name that same variable or condition in targetEvidence. Return only JSON: {"events":[{"sha":"exact event SHA","requirements":[{"behavior":"short user-facing change or fix title, not PR or commit title","classification":"missing|partial|present|no_target_impact|superseded|intentional_divergence|needs_investigation","rationale":"why target does or does not need adaptation","sourceEvidence":["specific source file and symbol or commit"],"targetEvidence":["specific target file and symbol or ref"],"dependencies":[],"featureArea":"area","groupKey":"short stable semantic key shared by equivalent changes across events","impact":"concrete effect on target users or code"}]}]}. Return every listed event exactly once, with at least one requirement. Split unrelated behaviors; give related requirements across PRs and commits the same groupKey. Do not classify as present or no impact from ancestry or file names alone. If code or documentation is insufficient, use needs_investigation and say exactly what remains unknown. Do not modify files.`;
}

export async function applyAssessment(
  store: Store,
  snapshot: AnalysisSnapshot,
  text: string,
  changes: ReadonlyMap<string, EventChange> = new Map(),
) {
  const proposal = proposalSchema.parse(extractAgentJson(text));
  const expected = new Set(snapshot.coverage.unprocessed);
  if (
    proposal.events.length !== expected.size ||
    new Set(proposal.events.map((event) => event.sha)).size !== expected.size ||
    proposal.events.some((event) => !expected.has(event.sha))
  )
    throw new Error(
      "AI assessment did not cover every pending integration event exactly once",
    );
  const updates = [];
  for (const item of proposal.events) {
    const gap = await store.gap(
      snapshot.pairId,
      `${snapshot.pairId}-${item.sha}`,
    );
    gap.requirements = item.requirements.map((requirement, index) => {
      const guarded = guardRequirement(requirement, {
        intentionalDecision: gap.intentionalDecision,
        symbols: changes.get(item.sha)?.symbols,
      });
      return {
        ...requirement,
        rationale: guarded.rationale,
        id: `${gap.id}-${index + 1}`,
        classification: guarded.classification,
      };
    });
    gap.updatedAt = new Date().toISOString();
    updates.push(gap);
  }
  for (const gap of updates) await store.saveGap(gap);
  snapshot.coverage.unprocessed = updates
    .filter((gap) =>
      gap.requirements.some(
        (requirement) => requirement.classification === "needs_investigation",
      ),
    )
    .map((gap) => gap.integrationSha);
  snapshot.coverage.assessed =
    snapshot.coverage.total - snapshot.coverage.unprocessed.length;
  snapshot.aiAssessedAt = new Date().toISOString();
  await store.saveSnapshot(snapshot);
  await store.writeReport(snapshot);
  return snapshot;
}
