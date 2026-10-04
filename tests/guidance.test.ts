import { describe, expect, it } from "vitest";
import {
  canResolveNoAction,
  canStartImplementation,
  gapNextStep,
  pairNextStep,
  workflowStages,
} from "../packages/web/src/guidance.js";
import type { Gap, PairHealth, Plan, Run } from "../packages/web/src/types.js";

const gap = (status: string, classification = "missing"): Gap => ({
  id: "pair-sha",
  pairId: "pair",
  integrationSha: "a".repeat(40),
  sourceSubject: "Change",
  updatedAt: "now",
  status,
  requirements: [
    {
      id: "r1",
      behavior: "Change",
      classification,
      rationale: "Reviewed",
      sourceEvidence: ["source:file"],
      targetEvidence: ["target:file"],
      dependencies: [],
      featureArea: "app",
    },
  ],
});
const plan: Plan = {
  sourceBehavior: "source",
  targetBehavior: "target",
  targetFiles: ["app.ts"],
  approach: "adapt",
  conventions: [],
  dependencies: [],
  regressionTests: ["test"],
  commands: [],
  manualScenarios: [],
  questions: [],
};
const run = (stage: string, status = ""): Run => ({
  stage,
  status,
  worktree: "worktree",
  branch: "branch",
  checks: [],
  manualResults: [],
});

describe("guided next steps", () => {
  it("points to setup, analysis, and assessment in order", () => {
    const pair: PairHealth = {
      id: "pair",
      name: "Pair",
      bound: false,
      gaps: 0,
      awaitingIntegration: 0,
    };
    expect(pairNextStep(pair)).toMatchObject({
      action: "Set up pair",
      href: "/setup",
    });
    pair.bound = true;
    expect(pairNextStep(pair).action).toBe("Analyze pair");
    pair.snapshot = {
      createdAt: "now",
      sourceSha: "a",
      targetSha: "b",
      fetchedAt: null,
      offline: true,
      events: [{}],
      coverage: { total: 1, assessed: 0, unprocessed: ["sha"] },
    };
    pair.nextGap = {
      id: "pair-sha",
      title: "Change",
      status: "open",
      needsInvestigation: true,
    };
    expect(pairNextStep(pair).action).toBe("Run analysis");
  });
  it("guides each gap gate and recognizes no-work resolution", () => {
    expect(gapNextStep(gap("open", "needs_investigation")).section).toBe(
      "Evidence",
    );
    expect(gapNextStep(gap("open"), undefined).section).toBe("Plan");
    expect(
      gapNextStep(gap("planned"), { ...plan, questions: ["Who owns it?"] })
        .title,
    ).toBe("Resolve plan questions");
    expect(
      gapNextStep(gap("planned"), {
        ...plan,
        questions: [{ question: "Who owns it?", answer: " " }],
      }).title,
    ).toBe("Resolve plan questions");
    expect(
      gapNextStep(gap("planned"), {
        ...plan,
        questions: [{ question: "Who owns it?", answer: "Platform" }],
      }).title,
    ).toBe("Review and approve the plan");
    expect(gapNextStep(gap("approved"), plan).section).toBe("Changes");
    expect(gapNextStep(gap("implementing"), plan, run("failed"))).toMatchObject(
      {
        title: "Retry implementation",
        action: "Retry implementation",
        section: "Changes",
      },
    );
    expect(
      gapNextStep(gap("implementing"), plan, {
        ...run("failed"),
        checks: [{ name: "test", status: "failed", output: "" }],
      }),
    ).toMatchObject({
      title: "Rerun validation",
      action: "Open validation",
      section: "Validation",
    });
    expect(
      canStartImplementation(gap("implementing"), {
        ...run("failed"),
        checks: [{ name: "test", status: "failed", output: "" }],
      }),
    ).toBe(false);
    expect(canStartImplementation(gap("approved"))).toBe(true);
    expect(canStartImplementation(gap("implementing"), run("failed"))).toBe(
      true,
    );
    expect(
      canStartImplementation(gap("implementing"), run("interrupted")),
    ).toBe(true);
    expect(
      canStartImplementation(gap("implementing"), run("implementing")),
    ).toBe(false);
    expect(
      gapNextStep(gap("implementing"), plan, run("validating")).section,
    ).toBe("Validation");
    expect(
      gapNextStep(gap("implementing"), plan, {
        ...run("validating"),
        checks: [
          { name: "production build", status: "passed", output: "" },
          {
            name: "test",
            status: "failed",
            output: "",
            blocking: false,
          },
        ],
      }).detail,
    ).toContain("Pipeline tests are non-blocking");
    expect(
      gapNextStep(gap("review_required"), plan, run("reviewing")).section,
    ).toBe("Review");
    expect(
      gapNextStep(gap("changes_requested"), plan, run("reviewing")).section,
    ).toBe("Changes");
    expect(
      gapNextStep(gap("verified_local"), plan, run("verified_local")).title,
    ).toContain("Hand off");
    expect(canResolveNoAction(gap("open", "present"))).toBe(true);
    expect(gapNextStep(gap("open", "present")).title).toContain("no-work");
    expect(gapNextStep(gap("resolved_no_action", "present")).title).toContain(
      "No target work",
    );
    expect(gapNextStep(gap("planned", "present"), plan).action).toBe(
      "Resolve gap",
    );
    expect(gapNextStep(gap("integrated"), plan).stage).toBe("review");
    expect(gapNextStep(gap("approved"), plan).stage).toBe("implement");
    expect(
      gapNextStep(gap("planned"), {
        ...plan,
        questions: [{ question: "Who owns it?", answer: "Platform" }],
      }).stage,
    ).toBe("approve");
    const stages = workflowStages(gap("approved"), plan);
    expect(stages.map((stage) => [stage.id, stage.state])).toEqual([
      ["evidence", "complete"],
      ["plan", "complete"],
      ["approve", "complete"],
      ["implement", "current"],
      ["validate", "blocked"],
      ["review", "blocked"],
    ]);
    expect(stages.find((stage) => stage.id === "validate")?.blocker).toMatch(
      /implementation/i,
    );
    expect(workflowStages(gap("open", "present"))[0].state).toBe("current");
  });
});
