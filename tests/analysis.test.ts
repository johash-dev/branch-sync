import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Store,
  type AnalysisSnapshot,
  type GapRecord,
  type PairConfig,
} from "@sync/engine";
import {
  applyAssessment,
  assessmentPrompt,
  changedSymbols,
  compactDiff,
} from "../packages/server/src/analysis.js";
import { extractAgentJson } from "../packages/server/src/agent-json.js";
import {
  cursorAcpLaunchArgs,
  cursorAcpResponse,
} from "../packages/server/src/providers.js";
import { reviewItems } from "../packages/web/src/review.js";

const sha = (digit: string) => digit.repeat(40);
async function setup() {
  const store = new Store(
    await mkdtemp(path.join(tmpdir(), "porting analysis ")),
  );
  const events = ["a", "b"].map((digit) => ({
    sha: sha(digit),
    parent: sha("0"),
    subject: `Merged PR ${digit}`,
    date: new Date().toISOString(),
    constituentCommits: [],
    files: [],
    empty: false,
  }));
  const snapshot: AnalysisSnapshot = {
    version: 1,
    id: "scan",
    pairId: "pair",
    createdAt: new Date().toISOString(),
    sourceSha: sha("a"),
    targetSha: sha("0"),
    baselineSha: sha("0"),
    fetchedAt: null,
    offline: true,
    knowledgeHash: "knowledge",
    configHash: "config",
    events,
    coverage: {
      total: 2,
      assessed: 0,
      unprocessed: events.map((event) => event.sha),
    },
  };
  await store.saveSnapshot(snapshot);
  for (const event of events) {
    const gap: GapRecord = {
      version: 1,
      id: `pair-${event.sha}`,
      pairId: "pair",
      integrationSha: event.sha,
      sourceSubject: event.subject,
      snapshotId: snapshot.id,
      status: "open",
      updatedAt: snapshot.createdAt,
      requirements: [
        {
          id: `pair-${event.sha}-1`,
          behavior: event.subject,
          classification: "needs_investigation",
          rationale: "Pending",
          sourceEvidence: [],
          targetEvidence: [],
          dependencies: [],
          featureArea: "unassigned",
          groupKey: "",
          impact: "",
        },
      ],
    };
    await store.saveGap(gap);
  }
  return { store, snapshot };
}

describe("automatic porting analysis", () => {
  it("requires coverage of every source event before saving decisions", async () => {
    const { store, snapshot } = await setup();
    await expect(
      applyAssessment(store, snapshot, JSON.stringify({ events: [] })),
    ).rejects.toThrow("every pending integration event");
    expect(
      (await store.gap("pair", `pair-${sha("a")}`)).requirements[0]
        .classification,
    ).toBe("needs_investigation");
  });

  it("groups related behaviors and keeps unsupported conclusions uncertain", async () => {
    const { store, snapshot } = await setup();
    const events = ["a", "b"].map((digit) => ({
      sha: sha(digit),
      requirements: [
        {
          behavior: "Retain form selection after refresh",
          classification: digit === "a" ? "missing" : "present",
          rationale: "Compared form state in both projects",
          sourceEvidence: [`source/form.ts:${digit}`],
          targetEvidence: digit === "a" ? ["target/form.ts"] : [],
          dependencies: [],
          featureArea: "forms",
          groupKey: "form-selection-refresh",
          impact: "Selection may be lost after refresh",
        },
      ],
    }));
    const assessed = await applyAssessment(
      store,
      snapshot,
      JSON.stringify({ events }),
    );
    expect(assessed.aiAssessedAt).toBeTruthy();
    expect(assessed.coverage.unprocessed).toEqual([sha("b")]);
    const gaps = await store.gaps("pair");
    const items = reviewItems(gaps, assessed);
    expect(items).toHaveLength(1);
    expect(items[0].decision).toBe("Port to target");
    expect(items[0].sourceShas).toHaveLength(2);
  });

  it("reads a JSON object that follows a prose preamble", async () => {
    const { store, snapshot } = await setup();
    const events = ["a", "b"].map((digit) => ({
      sha: sha(digit),
      requirements: [
        {
          behavior: "Keep the selected center after refresh",
          classification: "missing",
          rationale: "Target form drops the selection",
          sourceEvidence: [`source/form.ts:${digit}`],
          targetEvidence: [`target/form.ts:${digit}`],
          dependencies: [],
          featureArea: "forms",
          groupKey: "center-selection",
          impact: "The selection is lost after refresh",
        },
      ],
    }));
    const assessed = await applyAssessment(
      store,
      snapshot,
      `I'll analyze the pending integration events.\n${JSON.stringify({ events })}`,
    );
    expect(assessed.coverage.assessed).toBe(2);
    expect(
      extractAgentJson(`I'll analyze\n${JSON.stringify({ events })}`),
    ).toEqual({
      events,
    });
  });

  it("reads the last fenced JSON object", async () => {
    const { store, snapshot } = await setup();
    const events = ["a", "b"].map((digit) => ({
      sha: sha(digit),
      requirements: [
        {
          behavior: "Keep the selected center after refresh",
          classification: "present",
          rationale: "Target form already restores the selection",
          sourceEvidence: [`source/form.ts:${digit}`],
          targetEvidence: [`target/form.ts:${digit}`],
          dependencies: [],
          featureArea: "forms",
          groupKey: "center-selection",
          impact: "Refresh keeps the selection",
        },
      ],
    }));
    const assessed = await applyAssessment(
      store,
      snapshot,
      `I'll analyze this first.\n\`\`\`json\n${JSON.stringify({ note: "draft" })}\n\`\`\`\n\`\`\`json\n${JSON.stringify({ events })}\n\`\`\``,
    );
    expect(assessed.coverage.unprocessed).toEqual([]);
  });

  it("rejects a reply that never contains a JSON object", async () => {
    const { store, snapshot } = await setup();
    await expect(
      applyAssessment(
        store,
        snapshot,
        "I'll analyze the source and target next.",
      ),
    ).rejects.toThrow(
      "Agent reply was not JSON: I'll analyze the source and target next.",
    );
  });

  it("still requires every pending event when the object is wrapped in prose", async () => {
    const { store, snapshot } = await setup();
    await expect(
      applyAssessment(
        store,
        snapshot,
        `I'll analyze only the first event. ${JSON.stringify({
          events: [
            {
              sha: sha("a"),
              requirements: [
                {
                  behavior: "Keep the selected center after refresh",
                  classification: "missing",
                  rationale: "Target form drops the selection",
                  sourceEvidence: ["source/form.ts"],
                  targetEvidence: ["target/form.ts"],
                  dependencies: [],
                  featureArea: "forms",
                  groupKey: "center-selection",
                  impact: "The selection is lost after refresh",
                },
              ],
            },
          ],
        })}`,
      ),
    ).rejects.toThrow("every pending integration event");
  });

  it("rejects a layout-only no-impact call that omits the changed deploy symbol", async () => {
    const { store, snapshot } = await setup();
    const diff = [
      "diff --git a/azure-release-pipelines.yml b/azure-release-pipelines.yml",
      "--- a/azure-release-pipelines.yml",
      "+++ b/azure-release-pipelines.yml",
      "@@ -11,6 +11,8 @@",
      '+  enableDevelopBranchDeploy: "false"',
      "-    condition: and(succeeded('Build_Develop_Branch'), eq(variables['Build.SourceBranchName'], 'develop'))",
      "+    condition: and(succeeded('Build_Develop_Branch'), eq(variables['Build.SourceBranchName'], 'develop'), eq(variables['enableDevelopBranchDeploy'], 'true'))",
    ].join("\n");
    expect(changedSymbols(diff)).toEqual(["enableDevelopBranchDeploy"]);
    const events = ["a", "b"].map((digit) => ({
      sha: sha(digit),
      requirements: [
        {
          behavior: "Gate develop deploy behind enableDevelopBranchDeploy",
          classification: "no_target_impact",
          rationale: "Target pipeline uses a different branch",
          sourceEvidence: [
            "azure-release-pipelines.yml enableDevelopBranchDeploy",
          ],
          targetEvidence:
            digit === "a"
              ? ["azure-release-pipelines.yml trigger develop-acp / Deploy_Dev"]
              : ["azure-release-pipelines.yml enableDevelopBranchDeploy"],
          dependencies: [],
          featureArea: "ci-cd",
          groupKey: "develop-deploy-gate",
          impact: "Develop deploys stay off unless the variable is true",
        },
      ],
    }));
    const changes = new Map([
      [sha("a"), { diff, symbols: changedSymbols(diff) }],
      [sha("b"), { diff, symbols: changedSymbols(diff) }],
    ]);
    const assessed = await applyAssessment(
      store,
      snapshot,
      JSON.stringify({ events }),
      changes,
    );
    expect(assessed.coverage.unprocessed).toEqual([sha("a")]);
    const rejected = await store.gap("pair", `pair-${sha("a")}`);
    expect(rejected.requirements[0].classification).toBe("needs_investigation");
    expect(rejected.requirements[0].rationale).toContain(
      "enableDevelopBranchDeploy",
    );
    expect(
      (await store.gap("pair", `pair-${sha("b")}`)).requirements[0]
        .classification,
    ).toBe("no_target_impact");
    assessed.coverage.unprocessed = [sha("a"), sha("b")];
    const missing = ["a", "b"].map((digit) => ({
      sha: sha(digit),
      requirements: [
        {
          ...events[0].requirements[0],
          classification: "missing",
          targetEvidence: [
            "azure-release-pipelines.yml Deploy_Dev condition succeeded() without enableDevelopBranchDeploy",
          ],
        },
      ],
    }));
    const ported = await applyAssessment(
      store,
      assessed,
      JSON.stringify({ events: missing }),
      changes,
    );
    const items = reviewItems(await store.gaps("pair"), ported);
    expect(items).toHaveLength(1);
    expect(items[0].decision).toBe("Port to target");
    expect(items[0].sourceShas).toEqual([sha("a"), sha("b")]);
  });

  it("includes the first-parent diff and forbids a trigger-branch excuse", () => {
    const pair: PairConfig = {
      version: 1,
      id: "pair",
      name: "Pair",
      source: { remote: "origin", identity: "", ref: "source" },
      target: { remote: "origin", identity: "", ref: "target" },
      baseline: sha("0"),
      rules: ["Compare deploy variables and stage conditions"],
      mappings: [
        {
          source: "azure-release-pipelines.yml",
          target: "azure-release-pipelines.yml",
          note: "Compare deploy gates",
        },
      ],
      intentionalDifferences: [],
      validation: {
        install: null,
        build: { executable: "npm", args: ["run", "build"] },
        tests: [],
        manual: [],
      },
    };
    const snapshot: AnalysisSnapshot = {
      version: 1,
      id: "scan",
      pairId: "pair",
      createdAt: new Date().toISOString(),
      sourceSha: sha("a"),
      targetSha: sha("0"),
      baselineSha: sha("0"),
      fetchedAt: null,
      offline: true,
      knowledgeHash: "knowledge",
      configHash: "config",
      events: [
        {
          sha: sha("a"),
          parent: sha("0"),
          subject: "gate deploy",
          date: new Date().toISOString(),
          constituentCommits: [],
          files: [{ status: "M", path: "azure-release-pipelines.yml" }],
          empty: false,
        },
      ],
      coverage: { total: 1, assessed: 0, unprocessed: [sha("a")] },
    };
    const diff = '+  enableDevelopBranchDeploy: "false"';
    const prompt = assessmentPrompt(
      pair,
      snapshot,
      "source",
      "target",
      new Map([[sha("a"), { diff, symbols: ["enableDevelopBranchDeploy"] }]]),
    );
    expect(prompt).toContain("enableDevelopBranchDeploy");
    expect(prompt).toContain(
      "not enough to classify a missing deploy variable or stage condition as no_target_impact",
    );
    expect(prompt).toContain("azure-release-pipelines.yml");
    expect(
      compactDiff(
        `${"x".repeat(6001)}\n+    condition: eq(variables['enableDevelopBranchDeploy'], 'true')`,
      ),
    ).toContain("enableDevelopBranchDeploy");
  });
});

describe("Cursor ACP responses", () => {
  it("starts every Cursor job on Grok 4.7 at high effort", () => {
    expect(cursorAcpLaunchArgs).toEqual(["--model", "grok-4.7-high", "acp"]);
  });

  it("maps question and plan answers to ACP outcomes", () => {
    expect(
      cursorAcpResponse("cursor/ask_question", {
        answers: [{ questionId: "q1", selectedOptionIds: ["agent"] }],
      }),
    ).toEqual({
      outcome: {
        outcome: "answered",
        answers: [{ questionId: "q1", selectedOptionIds: ["agent"] }],
      },
    });
    expect(cursorAcpResponse("cursor/ask_question", { skipped: true })).toEqual(
      {
        outcome: { outcome: "skipped" },
      },
    );
    expect(cursorAcpResponse("cursor/create_plan", "accepted")).toEqual({
      outcome: { outcome: "accepted" },
    });
    expect(cursorAcpResponse("cursor/create_plan", "rejected")).toEqual({
      outcome: { outcome: "rejected", reason: "Developer rejected the plan" },
    });
    expect(
      cursorAcpResponse("session/request_permission", {
        optionId: "allow-once",
      }),
    ).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });
});
