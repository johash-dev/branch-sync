import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  Store,
  Workflow,
  chooseWorktreePath,
  completeDiff,
  diffFingerprint,
  diffNameStatusPaths,
  git,
  implementationAllowed,
  integrationEvents,
  pipelineTestStepIsNonBlocking,
  planSchema,
  porcelainStatusPaths,
  processRun,
  requiredChecksSatisfied,
  unansweredPlanQuestions,
  validationMilestone,
  WINDOWS_WORKTREE_PATH_BUDGET,
  worktreeCheckoutLength,
  type PairConfig,
  type PlanRevision,
} from "../packages/engine/src/index.js";

const nonBlockingPipeline = `steps:
  - script: |
      npm test -- --watch=false || true
    displayName: Run tests
    continueOnError: true
  - task: PublishPipelineArtifact@1
    inputs:
      artifactName: dist
`;

async function fixture(options?: {
  files?: Record<string, string>;
  tests?: { executable: string; args: string[] }[];
  build?: { executable: string; args: string[] };
}) {
  const root = await mkdtemp(path.join(tmpdir(), "branch sync test "));
  const repo = path.join(root, "repo with spaces");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "remote", "add", "origin", repo);
  await writeFile(path.join(repo, "app.txt"), "base\n");
  for (const [name, content] of Object.entries(options?.files ?? {}))
    await writeFile(path.join(repo, name), content);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "baseline");
  const baseline = await git(repo, "rev-parse", "HEAD");
  await git(repo, "branch", "target", baseline);
  await git(repo, "checkout", "-b", "source");
  await writeFile(path.join(repo, "app.txt"), "base\nsource change\n");
  await git(repo, "commit", "-am", "change behavior");
  const sourceCommit = await git(repo, "rev-parse", "HEAD");
  await git(repo, "checkout", "main");
  await git(repo, "merge", "--no-ff", "source", "-m", "integrate source");
  const merge = await git(repo, "rev-parse", "HEAD");
  const pair: PairConfig = {
    version: 1,
    id: "fixture",
    name: "Fixture",
    source: { remote: "origin", identity: repo, ref: "main" },
    target: { remote: "origin", identity: repo, ref: "target" },
    baseline,
    rules: [],
    mappings: [],
    intentionalDifferences: [],
    validation: {
      install: null,
      build: options?.build ?? { executable: "node", args: ["--version"] },
      tests: options?.tests ?? [{ executable: "node", args: ["--version"] }],
      manual: [],
    },
  };
  const store = new Store(root);
  await store.savePair(pair);
  await store.saveBinding({
    version: 1,
    pairs: { fixture: { sourcePath: repo, targetPath: repo } },
    defaultProvider: "codex",
  });
  return { root, repo, store, baseline, merge, sourceCommit };
}

describe("failed implementation retry", () => {
  it("reuses a clean failed worktree and allocates another when it is dirty", async () => {
    const f = await fixture();
    await f.store.scan("fixture", true);
    const gapId = `fixture-${f.merge}`;
    const gap = await f.store.gap("fixture", gapId);
    gap.requirements[0].classification = "missing";
    gap.requirements[0].targetEvidence = ["target:app.txt"];
    await f.store.saveGap(gap);
    const flow = new Workflow(f.store);
    await flow.revisePlan("fixture", gapId, {
      sourceBehavior: "Line added",
      targetBehavior: "Line appears",
      targetFiles: ["app.txt"],
      approach: "Copy behavior",
      conventions: [],
      dependencies: [],
      regressionTests: ["Check line"],
      commands: [],
      manualScenarios: [],
      questions: [],
    });
    await flow.approve("fixture", gapId, "Tester");
    const run = await flow.createRun("fixture", gapId);
    run.stage = "failed";
    await f.store.saveRun("fixture", run);
    const retried = await flow.createRun("fixture", gapId);
    expect(retried.worktree).toBe(run.worktree);
    expect(retried.branch).toBe(run.branch);
    expect(retried.id).not.toBe(run.id);
    await writeFile(path.join(retried.worktree, "app.txt"), "base\nedited\n");
    retried.stage = "interrupted";
    await f.store.saveRun("fixture", retried);
    const replaced = await flow.createRun("fixture", gapId);
    expect(replaced.worktree).not.toBe(retried.worktree);
  });
  it("reuses an unused branch at the approved base", async () => {
    const f = await fixture();
    await f.store.scan("fixture", true);
    const gapId = `fixture-${f.merge}`;
    const gap = await f.store.gap("fixture", gapId);
    gap.requirements[0].classification = "missing";
    gap.requirements[0].targetEvidence = ["target:app.txt"];
    await f.store.saveGap(gap);
    const flow = new Workflow(f.store);
    await flow.revisePlan("fixture", gapId, {
      sourceBehavior: "Line added",
      targetBehavior: "Line appears",
      targetFiles: ["app.txt"],
      approach: "Copy behavior",
      conventions: [],
      dependencies: [],
      regressionTests: ["Check line"],
      commands: [],
      manualScenarios: [],
      questions: [],
    });
    await flow.approve("fixture", gapId, "Tester");
    const run = await flow.createRun("fixture", gapId);
    await git(f.repo, "worktree", "remove", run.worktree);
    run.stage = "failed";
    await f.store.saveRun("fixture", run);
    const retried = await flow.createRun("fixture", gapId);
    expect(retried.branch).toBe(run.branch);
    expect(retried.worktree).toBe(run.worktree);
    expect(retried.id).not.toBe(run.id);
  });
});

describe("Windows worktree path selection", () => {
  const preferredRoot =
    "C:\\Users\\hasitha.m\\Desktop\\Johash\\branch-sync\\.local\\worktrees";
  const slug = "sep-acp-a939113db3";
  const shortRoot = "C:\\Users\\hasitha.m\\wt";
  const longestRelativePath = 187;
  it("selects the short fallback when the preferred Windows path is too long", () => {
    const preferred = path.win32.join(preferredRoot, slug);
    expect(
      worktreeCheckoutLength(preferred, longestRelativePath),
    ).toBeGreaterThan(WINDOWS_WORKTREE_PATH_BUDGET);
    expect(
      chooseWorktreePath({
        preferredRoot,
        slug,
        longestRelativePath,
        platform: "win32",
        shortRoot,
      }),
    ).toBe(path.win32.join(shortRoot, slug));
  });
  it("keeps a short preferred path and non-Windows checkouts under .local/worktrees", () => {
    expect(
      chooseWorktreePath({
        preferredRoot,
        slug,
        longestRelativePath: 10,
        platform: "win32",
        shortRoot,
      }),
    ).toBe(path.win32.join(preferredRoot, slug));
    expect(
      chooseWorktreePath({
        preferredRoot,
        slug,
        longestRelativePath,
        platform: "linux",
        shortRoot,
      }),
    ).toBe(path.posix.join(preferredRoot, slug));
  });
  it("names both lengths when neither Windows location fits", () => {
    const longPreferred = `C:\\${"p".repeat(220)}`;
    const longFallback = `C:\\${"s".repeat(220)}`;
    const preferredLength = worktreeCheckoutLength(
      path.win32.join(longPreferred, slug),
      longestRelativePath,
    );
    const fallbackLength = worktreeCheckoutLength(
      path.win32.join(longFallback, slug),
      longestRelativePath,
    );
    expect(() =>
      chooseWorktreePath({
        preferredRoot: longPreferred,
        slug,
        longestRelativePath,
        platform: "win32",
        shortRoot: longFallback,
      }),
    ).toThrow(
      `Worktree path would exceed Windows limit (${WINDOWS_WORKTREE_PATH_BUDGET}): preferred ${preferredLength} characters, fallback ${fallbackLength} characters`,
    );
  });
});

describe("plan question approval gate", () => {
  const plan = {
    version: 1 as const,
    id: "plan",
    gapId: "gap",
    revision: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    sourceBehavior: "source",
    targetBehavior: "target",
    targetFiles: ["app.txt"],
    approach: "adapt",
    conventions: [],
    dependencies: [],
    regressionTests: ["check"],
    commands: [],
    manualScenarios: [],
    hash: "hash",
  };
  it("keeps legacy question strings and saved answers", () => {
    expect(
      planSchema.parse({ ...plan, questions: ["Who owns it?"] }).questions,
    ).toEqual(["Who owns it?"]);
    expect(
      planSchema.parse({
        ...plan,
        questions: [{ question: "Who owns it?", answer: "Platform" }],
      }).questions,
    ).toEqual([{ question: "Who owns it?", answer: "Platform" }]);
    expect(unansweredPlanQuestions(["Who owns it?"])).toHaveLength(1);
    expect(
      unansweredPlanQuestions([{ question: "Who owns it?", answer: "  " }]),
    ).toHaveLength(1);
    expect(
      unansweredPlanQuestions([
        { question: "Who owns it?", answer: "Platform" },
      ]),
    ).toHaveLength(0);
    expect(
      unansweredPlanQuestions(["  ", { question: " ", answer: "" }]),
    ).toHaveLength(0);
  });
  it("blocks approval until every saved question has an answer", async () => {
    const f = await fixture();
    await f.store.scan("fixture", true);
    const gapId = `fixture-${f.merge}`;
    const gap = await f.store.gap("fixture", gapId);
    gap.requirements[0].classification = "missing";
    gap.requirements[0].rationale = "Target branch lacks the line";
    gap.requirements[0].targetEvidence = ["target:app.txt"];
    await f.store.saveGap(gap);
    const flow = new Workflow(f.store);
    const input = {
      sourceBehavior: "Line added",
      targetBehavior: "Line appears",
      targetFiles: ["app.txt"],
      approach: "Adapt file",
      conventions: [],
      dependencies: [],
      regressionTests: ["Check line"],
      commands: [],
      manualScenarios: [],
    };
    await flow.revisePlan("fixture", gapId, {
      ...input,
      questions: ["Who owns it?"],
    });
    await expect(flow.approve("fixture", gapId, "Tester")).rejects.toThrow(
      "unresolved questions",
    );
    await flow.revisePlan("fixture", gapId, {
      ...input,
      questions: [{ question: "Who owns it?", answer: "  " }],
    });
    await expect(flow.approve("fixture", gapId, "Tester")).rejects.toThrow(
      "unresolved questions",
    );
    await flow.revisePlan("fixture", gapId, {
      ...input,
      questions: [
        { question: "Who owns it?", answer: "Platform" },
        "Still open?",
      ],
    });
    await expect(flow.approve("fixture", gapId, "Tester")).rejects.toThrow(
      "unresolved questions",
    );
    await flow.revisePlan("fixture", gapId, {
      ...input,
      questions: [{ question: "Who owns it?", answer: "Platform" }],
    });
    await expect(
      flow.approve("fixture", gapId, "Tester"),
    ).resolves.toMatchObject({ approvedBy: "Tester" });
  });
});

describe("Git history and workflow gates", () => {
  it("fetches missing baseline history from a shallow source checkout", async () => {
    const f = await fixture();
    const shallow = path.join(f.root, "shallow source");
    await git(
      f.root,
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      pathToFileURL(f.repo).href,
      shallow,
    );
    expect(await git(shallow, "rev-parse", "--is-shallow-repository")).toBe(
      "true",
    );
    const pair = await f.store.pair("fixture");
    pair.source = { remote: "origin", identity: "", ref: "origin/main" };
    pair.target = { remote: "origin", identity: "", ref: "origin/main" };
    await f.store.savePair(pair);
    await f.store.saveBinding({
      version: 1,
      pairs: { fixture: { sourcePath: shallow, targetPath: shallow } },
      defaultProvider: "codex",
    });
    const snapshot = await f.store.scan("fixture", false);
    expect(snapshot.baselineSha).toBe(f.baseline);
    expect(snapshot.events.map((event) => event.sha)).toEqual([f.merge]);
  });
  it("records a no-work decision and reopens it when pair knowledge changes", async () => {
    const f = await fixture();
    await f.store.scan("fixture", true);
    const gapId = `fixture-${f.merge}`;
    const gap = await f.store.gap("fixture", gapId);
    const flow = new Workflow(f.store);
    await expect(
      flow.resolveNoAction("fixture", gapId, "Tester", "Already present"),
    ).rejects.toThrow("Classify every requirement");
    gap.requirements[0].classification = "present";
    gap.requirements[0].rationale = "Equivalent behavior exists on target";
    gap.requirements[0].targetEvidence = ["target:app.txt"];
    await f.store.saveGap(gap);
    const resolved = await flow.resolveNoAction(
      "fixture",
      gapId,
      "Tester",
      "Target already handles it",
    );
    expect(resolved.status).toBe("resolved_no_action");
    expect(resolved.noActionResolution?.decidedBy).toBe("Tester");
    await f.store.scan("fixture", true);
    expect((await f.store.gap("fixture", gapId)).status).toBe(
      "resolved_no_action",
    );
    const pair = await f.store.pair("fixture");
    pair.rules.push("New mapping decision");
    await f.store.savePair(pair);
    await f.store.scan("fixture", true);
    const reopened = await f.store.gap("fixture", gapId);
    expect(reopened.status).toBe("open");
    expect(reopened.noActionResolution).toBeUndefined();
    expect(reopened.requirements[0].classification).toBe("needs_investigation");
  });
  it("collects first-parent integration diffs without double counting merged commits", async () => {
    const f = await fixture();
    const events = await integrationEvents(f.repo, f.baseline, f.merge);
    expect(events).toHaveLength(1);
    expect(events[0].sha).toBe(f.merge);
    expect(events[0].files.map((x) => x.path)).toContain("app.txt");
    expect(events[0].constituentCommits).toContain(f.sourceCommit);
    const snapshot = await f.store.scan("fixture", true);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.coverage.unprocessed).toEqual([f.merge]);
    const snapshot2 = await f.store.scan("fixture", true);
    expect((await f.store.gaps("fixture")).map((x) => x.id)).toEqual([
      `fixture-${f.merge}`,
    ]);
    expect(snapshot2.events[0].sha).toBe(f.merge);
  });
  it("reassesses older open gaps that lack a behavior grouping", async () => {
    const f = await fixture();
    await f.store.scan("fixture", true);
    const gap = await f.store.gap("fixture", `fixture-${f.merge}`);
    gap.requirements[0].classification = "missing";
    await f.store.saveGap(gap);
    expect(
      (await f.store.scan("fixture", true)).coverage.unprocessed,
    ).toContain(f.merge);
    gap.requirements[0].groupKey = "changed-behavior";
    await f.store.saveGap(gap);
    expect(
      (await f.store.scan("fixture", true)).coverage.unprocessed,
    ).not.toContain(f.merge);
  });
  it("binds approval to the exact plan and all configuration", async () => {
    const f = await fixture();
    await f.store.scan("fixture", true);
    const gapId = `fixture-${f.merge}`;
    const gap = await f.store.gap("fixture", gapId);
    gap.requirements[0].classification = "missing";
    gap.requirements[0].rationale = "Target branch lacks the line";
    gap.requirements[0].targetEvidence = ["target:app.txt"];
    await f.store.saveGap(gap);
    const flow = new Workflow(f.store);
    await flow.revisePlan("fixture", gapId, {
      sourceBehavior: "Line added",
      targetBehavior: "Line appears",
      targetFiles: ["app.txt"],
      approach: "Adapt file",
      conventions: [],
      dependencies: [],
      regressionTests: ["Check line"],
      commands: [],
      manualScenarios: [],
      questions: [],
    });
    await flow.approve("fixture", gapId, "Tester");
    await expect(flow.requireApproval("fixture", gapId)).resolves.toBeDefined();
    const pair = await f.store.pair("fixture");
    pair.rules.push("New rule");
    await f.store.savePair(pair);
    await f.store.scan("fixture", true);
    await expect(flow.requireApproval("fixture", gapId)).rejects.toThrow(
      "stale",
    );
  });
  it("includes untracked file bytes in the review fingerprint", async () => {
    const f = await fixture();
    const first = await diffFingerprint(f.repo, f.baseline);
    await writeFile(path.join(f.repo, "new.txt"), "one");
    const second = await diffFingerprint(f.repo, f.baseline);
    await writeFile(path.join(f.repo, "new.txt"), "two");
    const third = await diffFingerprint(f.repo, f.baseline);
    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
    expect(await completeDiff(f.repo, f.baseline)).toContain(
      "Untracked file: new.txt\ntwo",
    );
  });
  it("keeps review valid for an exact commit and confirms a reachable integration", async () => {
    const f = await fixture();
    await f.store.scan("fixture", true);
    const gapId = `fixture-${f.merge}`;
    const gap = await f.store.gap("fixture", gapId);
    gap.requirements[0].classification = "missing";
    gap.requirements[0].targetEvidence = ["target:app.txt"];
    await f.store.saveGap(gap);
    const flow = new Workflow(f.store);
    await flow.revisePlan("fixture", gapId, {
      sourceBehavior: "Line added",
      targetBehavior: "Line appears",
      targetFiles: ["app.txt"],
      approach: "Copy behavior",
      conventions: [],
      dependencies: [],
      regressionTests: ["Check line"],
      commands: [],
      manualScenarios: [],
      questions: [],
    });
    await flow.approve("fixture", gapId, "Tester");
    const run = await flow.createRun("fixture", gapId);
    await writeFile(
      path.join(run.worktree, "app.txt"),
      "base\nsource change\n",
    );
    const validated = await flow.validate("fixture", gapId);
    expect(validated.stage).toBe("reviewing");
    const reviewed = await flow.recordReview("fixture", gapId, "approved", []);
    expect(reviewed.stage).toBe("verified_local");
    const before = await diffFingerprint(run.worktree, run.baseSha);
    await git(run.worktree, "add", "app.txt");
    await git(run.worktree, "commit", "-m", "adapt source behavior");
    const after = await diffFingerprint(run.worktree, run.baseSha);
    expect(after).toBe(before);
    const commit = await git(run.worktree, "rev-parse", "HEAD");
    await git(f.repo, "branch", "-f", "target", commit);
    const integrated = await flow.confirmIntegration("fixture", gapId, commit, [
      "Reviewed file present on target",
    ]);
    expect(integrated.status).toBe("integrated");
    await git(f.repo, "checkout", "target");
    await git(f.repo, "revert", "--no-edit", commit);
    const rescan = await f.store.scan("fixture", true);
    expect(rescan.coverage.unprocessed).toContain(f.merge);
    const reopened = await f.store.gap("fixture", gapId);
    expect(reopened.status).toBe("open");
    expect(reopened.requirements[0].rationale).toContain(
      "Reviewed target file changed",
    );
  });
});

describe("pipeline test policy", { timeout: 120000 }, () => {
  it("recognizes a non-blocking Azure test step", () => {
    expect(pipelineTestStepIsNonBlocking(nonBlockingPipeline)).toBe(true);
    expect(
      pipelineTestStepIsNonBlocking(`steps:
  - script: npm test
  - script: echo deploy
    continueOnError: true`),
    ).toBe(false);
    expect(
      pipelineTestStepIsNonBlocking(`steps:
  - script: |
      npm test || true`),
    ).toBe(true);
    expect(
      requiredChecksSatisfied([
        { name: "production build", status: "passed" },
        { name: "test", status: "failed", blocking: false },
      ]),
    ).toBe(true);
    expect(
      requiredChecksSatisfied([
        { name: "production build", status: "failed" },
        { name: "test", status: "failed", blocking: false },
      ]),
    ).toBe(false);
  });

  async function ready(
    options: Parameters<typeof fixture>[0],
    plan?: {
      commands?: { executable: string; args: string[] }[];
      manualScenarios?: string[];
    },
  ) {
    const f = await fixture(options);
    await f.store.scan("fixture", true);
    const gapId = `fixture-${f.merge}`;
    const gap = await f.store.gap("fixture", gapId);
    gap.requirements[0].classification = "missing";
    gap.requirements[0].targetEvidence = ["target:app.txt"];
    await f.store.saveGap(gap);
    const flow = new Workflow(f.store);
    await flow.revisePlan("fixture", gapId, {
      sourceBehavior: "Line added",
      targetBehavior: "Line appears",
      targetFiles: ["app.txt"],
      approach: "Adapt file",
      conventions: [],
      dependencies: [],
      regressionTests: ["Check line"],
      commands: plan?.commands ?? [],
      manualScenarios: plan?.manualScenarios ?? [],
      questions: [],
    });
    await flow.approve("fixture", gapId, "Tester");
    await flow.createRun("fixture", gapId);
    return { f, flow, gapId };
  }

  it("continues after a non-blocking test failure when the production build passes", async () => {
    const { flow, gapId } = await ready(
      {
        files: { "azure-release-pipelines.yml": nonBlockingPipeline },
        tests: [{ executable: "node", args: ["-e", "process.exit(1)"] }],
      },
      { manualScenarios: ["Observe the pipeline gate"] },
    );
    const validated = await flow.validate("fixture", gapId);
    expect(validated.stage).toBe("validating");
    expect(validated.status).toContain("non-blocking");
    const test = validated.checks.find((check) => check.name === "test");
    expect(test).toMatchObject({ status: "failed", blocking: false });
    expect(
      validated.checks.find((check) => check.name === "production build")
        ?.status,
    ).toBe("passed");
  });

  it("still stops when the production build fails", async () => {
    const { flow, gapId } = await ready({
      files: { "azure-release-pipelines.yml": nonBlockingPipeline },
      build: { executable: "node", args: ["-e", "process.exit(1)"] },
      tests: [{ executable: "node", args: ["--version"] }],
    });
    const validated = await flow.validate("fixture", gapId);
    expect(validated.stage).toBe("failed");
    expect(validated.checks.map((check) => check.name)).toEqual([
      "production build",
    ]);
  });

  it("still stops when pipeline tests are blocking", async () => {
    const { flow, gapId } = await ready({
      tests: [{ executable: "node", args: ["-e", "process.exit(1)"] }],
    });
    const validated = await flow.validate("fixture", gapId);
    expect(validated.stage).toBe("failed");
    expect(validated.checks.find((check) => check.name === "test")).toMatchObject(
      { status: "failed", blocking: true },
    );
  });

  it("keeps focused plan commands blocking and reuses a passed build for the same tree", async () => {
    const { f, flow, gapId } = await ready(
      {
        files: { "azure-release-pipelines.yml": nonBlockingPipeline },
        tests: [{ executable: "node", args: ["-e", "process.exit(1)"] }],
      },
      { commands: [{ executable: "node", args: ["--version"] }] },
    );
    const validated = await flow.validate("fixture", gapId);
    expect(validated.stage).toBe("reviewing");
    expect(validated.checks.map((check) => check.blocking)).toEqual([
      true,
      false,
      true,
    ]);
    const reviewed = await flow.recordReview("fixture", gapId, "approved", []);
    expect(reviewed.stage).toBe("verified_local");
    const build = reviewed.checks.find(
      (check) => check.name === "production build",
    );
    if (!build) throw new Error("missing build check");
    build.output = "REUSED-BUILD";
    await f.store.saveRun("fixture", reviewed);
    const again = await flow.validate("fixture", gapId);
    expect(
      again.checks.find((check) => check.name === "production build")?.output,
    ).toBe("REUSED-BUILD");
    await writeFile(path.join(again.worktree, "app.txt"), "base\nedited\n");
    const changed = await flow.validate("fixture", gapId);
    expect(
      changed.checks.find((check) => check.name === "production build")?.output,
    ).not.toBe("REUSED-BUILD");
  }, 60000);
});

describe("source commit checks", { timeout: 120000 }, () => {
  it("runs git show of a source-only commit in the source checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "branch sync source show "));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await mkdir(source);
    await mkdir(target);
    for (const repo of [source, target]) {
      await git(repo, "init", "-b", "main");
      await git(repo, "config", "user.name", "Test");
      await git(repo, "config", "user.email", "test@example.invalid");
      await git(repo, "remote", "add", "origin", repo);
    }
    await writeFile(path.join(source, "app.txt"), "base\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "baseline");
    const baseline = await git(source, "rev-parse", "HEAD");
    await writeFile(path.join(source, "app.txt"), "source-only-line\n");
    await git(source, "commit", "-am", "change behavior");
    const sourceCommit = await git(source, "rev-parse", "HEAD");
    await writeFile(path.join(target, "app.txt"), "target file on disk\n");
    await git(target, "add", ".");
    await git(target, "commit", "-m", "target baseline");
    const pair: PairConfig = {
      version: 1,
      id: "split",
      name: "Split",
      source: { remote: "origin", identity: source, ref: "main" },
      target: { remote: "origin", identity: target, ref: "main" },
      baseline,
      rules: [],
      mappings: [],
      intentionalDifferences: [],
      validation: {
        install: null,
        build: { executable: "node", args: ["--version"] },
        tests: [{ executable: "node", args: ["--version"] }],
        manual: [],
      },
    };
    const store = new Store(root);
    await store.savePair(pair);
    await store.saveBinding({
      version: 1,
      pairs: { split: { sourcePath: source, targetPath: target } },
      defaultProvider: "codex",
    });
    await store.scan("split", true);
    const gapId = `split-${sourceCommit}`;
    const gap = await store.gap("split", gapId);
    gap.requirements[0].classification = "missing";
    gap.requirements[0].targetEvidence = ["target:app.txt"];
    await store.saveGap(gap);
    const flow = new Workflow(store);
    await flow.revisePlan("split", gapId, {
      sourceBehavior: "Line replaced",
      targetBehavior: "Line appears",
      targetFiles: ["app.txt"],
      approach: "Adapt file",
      conventions: [],
      dependencies: [],
      regressionTests: ["Read the source file"],
      commands: [
        {
          executable: "git",
          args: ["show", `${sourceCommit}:app.txt`],
        },
      ],
      manualScenarios: [],
      questions: [],
    });
    await flow.approve("split", gapId, "Tester");
    await flow.createRun("split", gapId);
    const validated = await flow.validate("split", gapId);
    const shown = validated.checks.find((check) =>
      check.command?.args.includes(`${sourceCommit}:app.txt`),
    );
    expect(shown).toMatchObject({ status: "passed", blocking: true });
    expect(shown?.output).toContain("source-only-line");
    expect(validated.stage).toBe("reviewing");
  });
});

describe("scope parsing and execution gates", () => {
  it("keeps both paths from rename and copy records", () => {
    expect(porcelainStatusPaths("R  old file.txt\0new file.txt\0")).toEqual([
      "old file.txt",
      "new file.txt",
    ]);
    expect(porcelainStatusPaths("C  old.txt\0copy.txt\0")).toEqual([
      "old.txt",
      "copy.txt",
    ]);
    expect(porcelainStatusPaths(" M app.txt\0?? extra.txt\0")).toEqual([
      "app.txt",
      "extra.txt",
    ]);
    expect(diffNameStatusPaths("R100\0old.txt\0new.txt\0M\0app.txt\0")).toEqual(
      ["old.txt", "new.txt", "app.txt"],
    );
    expect(implementationAllowed({ status: "approved" }, null)).toBe(true);
    expect(
      implementationAllowed({ status: "implementing" }, { stage: "failed" }),
    ).toBe(true);
    expect(
      implementationAllowed(
        { status: "implementing" },
        { stage: "implementing" },
      ),
    ).toBe(false);
    const milestone = validationMilestone({
      index: 1,
      total: 5,
      name: "production build",
      phase: "running",
      completed: 1,
      blocking: true,
    });
    expect(milestone.summary).toBe("Check 2 of 5: production build");
    expect(JSON.stringify(milestone)).not.toContain("output");
  });

  it("throttles command activity without copying output", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sync activity "));
    const first: string[] = [];
    await processRun(
      "node",
      ["-e", "process.stdout.write('secret-one')"],
      cwd,
      undefined,
      (activity) => first.push(JSON.stringify(activity)),
    );
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("lastOutputAt");
    expect(first[0]).not.toContain("secret");
    const quiet: string[] = [];
    await processRun(
      "node",
      ["-e", "process.exit(0)"],
      cwd,
      undefined,
      () => quiet.push("output"),
    );
    expect(quiet).toEqual([]);
    const controller = new AbortController();
    const pending = processRun(
      "node",
      ["-e", "setTimeout(() => {}, 30000)"],
      cwd,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("rejects renames outside the approved set and rechecks implementation state", async () => {
    const f = await fixture();
    await f.store.scan("fixture", true);
    const gapId = `fixture-${f.merge}`;
    const gap = await f.store.gap("fixture", gapId);
    gap.requirements[0].classification = "missing";
    gap.requirements[0].targetEvidence = ["target:app.txt"];
    await f.store.saveGap(gap);
    const flow = new Workflow(f.store);
    await flow.revisePlan("fixture", gapId, {
      sourceBehavior: "Line added",
      targetBehavior: "Line appears",
      targetFiles: ["app.txt"],
      approach: "Copy behavior",
      conventions: [],
      dependencies: [],
      regressionTests: ["Check line"],
      commands: [],
      manualScenarios: [],
      questions: [],
    });
    await expect(flow.approve("fixture", gapId, "  ")).rejects.toThrow(/name/i);
    await flow.approve("fixture", gapId, "Tester");
    gap.status = "planned";
    await f.store.saveGap(gap);
    await expect(flow.createRun("fixture", gapId)).rejects.toThrow(
      /Approve the current plan/,
    );
    gap.status = "approved";
    await f.store.saveGap(gap);
    const run = await flow.createRun("fixture", gapId);
    await git(run.worktree, "mv", "app.txt", "renamed.txt");
    const plan = { targetFiles: ["app.txt"] } as PlanRevision;
    await expect(flow.checkScope(run, plan)).rejects.toThrow(/renamed\.txt/);
    await expect(
      flow.checkScope(run, {
        targetFiles: ["app.txt", "renamed.txt"],
      } as PlanRevision),
    ).resolves.toBeUndefined();
  });
});

describe("validation progress", () => {
  it("reports ordered phases, survives a throwing observer, and cancels cleanly", async () => {
    const f = await fixture({
      build: { executable: "node", args: ["-e", "process.exit(0)"] },
      tests: [{ executable: "node", args: ["--version"] }],
    });
    await f.store.scan("fixture", true);
    const gapId = `fixture-${f.merge}`;
    const gap = await f.store.gap("fixture", gapId);
    gap.requirements[0].classification = "missing";
    gap.requirements[0].targetEvidence = ["target:app.txt"];
    await f.store.saveGap(gap);
    const flow = new Workflow(f.store);
    await flow.revisePlan("fixture", gapId, {
      sourceBehavior: "Line added",
      targetBehavior: "Line appears",
      targetFiles: ["app.txt"],
      approach: "Adapt file",
      conventions: [],
      dependencies: [],
      regressionTests: ["Check line"],
      commands: [],
      manualScenarios: [],
      questions: [],
    });
    await flow.approve("fixture", gapId, "Tester");
    await flow.createRun("fixture", gapId);
    const phases: string[] = [];
    let activity = 0;
    const validated = await flow.validate("fixture", gapId, undefined, {
      onProgress: (progress) => {
        phases.push(`${progress.phase}:${progress.name}`);
        if (phases.length === 1) throw new Error("observer must not authorize");
      },
      onActivity: (update) => {
        activity += 1;
        expect(JSON.stringify(update)).not.toContain("output");
      },
    });
    expect(validated.stage).toBe("reviewing");
    expect(phases).toContain("pending:production build");
    expect(phases).toContain("running:production build");
    expect(phases).toContain("passed:production build");
    expect(activity).toBeGreaterThan(0);
    const again = await flow.validate("fixture", gapId, undefined, {
      onProgress: (progress) => phases.push(`again:${progress.phase}:${progress.name}`),
    });
    expect(again.checks[0]?.status).toBe("passed");
    expect(phases.some((phase) => phase.startsWith("again:reused:"))).toBe(true);
    const slow = await fixture({
      build: {
        executable: "node",
        args: ["-e", "setTimeout(() => {}, 30000)"],
      },
      tests: [{ executable: "node", args: ["--version"] }],
    });
    await slow.store.scan("fixture", true);
    const slowGapId = `fixture-${slow.merge}`;
    const slowGap = await slow.store.gap("fixture", slowGapId);
    slowGap.requirements[0].classification = "missing";
    slowGap.requirements[0].targetEvidence = ["target:app.txt"];
    await slow.store.saveGap(slowGap);
    const slowFlow = new Workflow(slow.store);
    await slowFlow.revisePlan("fixture", slowGapId, {
      sourceBehavior: "Line added",
      targetBehavior: "Line appears",
      targetFiles: ["app.txt"],
      approach: "Adapt file",
      conventions: [],
      dependencies: [],
      regressionTests: ["Check line"],
      commands: [],
      manualScenarios: [],
      questions: [],
    });
    await slowFlow.approve("fixture", slowGapId, "Tester");
    await slowFlow.createRun("fixture", slowGapId);
    const controller = new AbortController();
    const cancelling = slowFlow.validate(
      "fixture",
      slowGapId,
      controller.signal,
    );
    controller.abort();
    await expect(cancelling).rejects.toThrow(/cancelled/i);
    expect((await slow.store.latestRun("fixture", slowGapId))?.stage).toBe(
      "interrupted",
    );
  }, 60000);
});
