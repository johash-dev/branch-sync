import type { Gap, PairHealth } from "./types.js";

export type ReviewItem = {
  key: string;
  title: string;
  impact: string;
  featureArea: string;
  decision: "Port to target" | "Investigate" | "No port needed";
  gaps: Gap[];
  sourceShas: string[];
};

export function reviewItems(
  gaps: Gap[],
  snapshot?: PairHealth["snapshot"],
): ReviewItem[] {
  if (!snapshot?.aiAssessedAt) return [];
  const groups = new Map<string, ReviewItem>();
  const current = new Set(snapshot.events.map((event) => event.sha));
  for (const gap of gaps) {
    if (!current.has(gap.integrationSha)) continue;
    for (const requirement of gap.requirements) {
      const key = requirement.groupKey || requirement.id;
      const decision = ["missing", "partial"].includes(
        requirement.classification,
      )
        ? "Port to target"
        : requirement.classification === "needs_investigation"
          ? "Investigate"
          : "No port needed";
      const item = groups.get(key);
      if (item) {
        if (
          decision === "Port to target" ||
          (decision === "Investigate" && item.decision === "No port needed")
        )
          item.decision = decision;
        if (!item.gaps.some((candidate) => candidate.id === gap.id))
          item.gaps.push(gap);
        if (!item.sourceShas.includes(gap.integrationSha))
          item.sourceShas.push(gap.integrationSha);
      } else
        groups.set(key, {
          key,
          title: requirement.behavior,
          impact: requirement.impact || requirement.rationale,
          featureArea: requirement.featureArea,
          decision,
          gaps: [gap],
          sourceShas: [gap.integrationSha],
        });
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      ["Port to target", "Investigate", "No port needed"].indexOf(a.decision) -
      ["Port to target", "Investigate", "No port needed"].indexOf(b.decision),
  );
}
