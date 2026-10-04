import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../packages/server/src/app.js";
import { Jobs } from "../packages/server/src/jobs.js";
import {
  normalizeAgentActivity,
  selectedProvider,
} from "../packages/server/src/providers.js";
import {
  pairConfigSchema,
  localBindingSchema,
} from "../packages/engine/src/schema.js";
import { validationMilestone } from "../packages/engine/src/workflow.js";

describe("Local API and job recovery", () => {
  it("uses the local Cursor choice even when legacy pair JSON names Codex", () => {
    const legacy = pairConfigSchema.parse({
      version: 1,
      id: "pair",
      name: "Pair",
      baseline: "a".repeat(40),
      source: { remote: "origin", ref: "main" },
      target: { remote: "origin", ref: "target" },
      validation: {
        install: null,
        build: { executable: "npm", args: ["run", "build"] },
        tests: [],
        manual: [],
      },
      provider: "codex",
    });
    const binding = localBindingSchema.parse({
      version: 1,
      pairs: {},
      defaultProvider: "cursor",
    });
    expect("provider" in legacy).toBe(false);
    expect(selectedProvider(binding)).toBe("cursor");
  });
  it("rejects foreign origins and requires the session token for changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sync api test "));
    const { app } = createApp(root);
    try {
      const bad = await app.inject({
        method: "POST",
        url: "/api/bindings",
        headers: { origin: "https://example.invalid" },
        payload: {},
      });
      expect(bad.statusCode).toBe(403);
      const missing = await app.inject({
        method: "POST",
        url: "/api/bindings",
        payload: {},
      });
      expect(missing.statusCode).toBe(403);
      const token = (await app.inject("/api/session")).json().token;
      const allowed = await app.inject({
        method: "POST",
        url: "/api/bindings",
        headers: { "x-sync-token": token },
        payload: { version: 1, pairs: {}, defaultProvider: "codex" },
      });
      expect(allowed.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it("marks a running job interrupted after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sync job test "));
    const dir = path.join(root, ".local", "jobs");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "run.json"),
      JSON.stringify({
        id: "run",
        kind: "implement",
        pairId: "example",
        status: "running",
        events: [],
        interactions: [],
      }),
    );
    const jobs = new Jobs(root);
    await jobs.recover();
    expect(jobs.all.get("run")?.status).toBe("failed");
    expect(jobs.all.get("run")?.error).toContain("Interrupted");
    expect(
      JSON.parse(await readFile(path.join(dir, "run.json"), "utf8")).events[0]
        .type,
    ).toBe("interrupted");
  });
  it("accepts a text agent response through the JSON interaction envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sync interaction test "));
    const { app, jobs } = createApp(root);
    try {
      const token = (await app.inject("/api/session")).json().token;
      const job = jobs.enqueue("test", "pair", undefined, async (running) =>
        jobs.ask(running, "permission", { command: "git status" }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      const interaction = job.interactions[0];
      expect(interaction).toBeDefined();
      const response = await app.inject({
        method: "POST",
        url: `/api/jobs/${job.id}/interactions/${interaction.id}`,
        headers: { "x-sync-token": token },
        payload: { value: "allow" },
      });
      expect(response.statusCode).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(job.status).toBe("done");
      expect(job.result).toBe("allow");
    } finally {
      await app.close();
    }
  });
  it("streams a job snapshot and completion over one connection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sync stream test "));
    const { app, jobs } = createApp(root);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = jobs.enqueue("analyze", "pair", undefined, async () => {
      await gate;
      return { complete: true };
    });
    let reads = 0;
    app.addHook("onRequest", async (req) => {
      if (req.method === "GET" && req.url.startsWith(`/api/jobs/${job.id}`))
        reads++;
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(`${address}/api/jobs/${job.id}/events`);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let output = "";
      const until = async (marker: string) => {
        while (!output.includes(marker)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`Stream ended before ${marker}`);
          output += decoder.decode(chunk.value);
        }
      };
      await until("event: snapshot");
      expect(output).toContain(`"id":"${job.id}"`);
      release();
      await until("event: update");
      await until('"status":"done"');
      expect(reads).toBe(1);
      await reader.cancel();
    } finally {
      release();
      await app.close();
    }
  });

  it("rejects lifecycle field writes, blank names, missing bindings, and duplicate jobs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sync lifecycle "));
    const { app, store, workflow, jobs } = createApp(root);
    const sha = "a".repeat(40);
    try {
      const token = (await app.inject("/api/session")).json().token;
      const headers = { "x-sync-token": token };
      await store.savePair({
        version: 1,
        id: "pair",
        name: "Pair",
        source: { remote: "origin", identity: "", ref: "main" },
        target: { remote: "origin", identity: "", ref: "main" },
        baseline: sha,
        rules: [],
        mappings: [],
        intentionalDifferences: [],
        validation: {
          install: null,
          build: { executable: "node", args: ["--version"] },
          tests: [{ executable: "node", args: ["--version"] }],
          manual: [],
        },
      });
      await store.saveGap({
        version: 1,
        id: "gap-1",
        pairId: "pair",
        integrationSha: sha,
        sourceSubject: "Change",
        snapshotId: "snap",
        requirements: [
          {
            id: "r1",
            behavior: "Change",
            classification: "missing",
            rationale: "Reviewed",
            sourceEvidence: ["source"],
            targetEvidence: ["target"],
            dependencies: [],
            featureArea: "app",
            groupKey: "",
            impact: "",
          },
        ],
        status: "open",
        updatedAt: new Date().toISOString(),
      });
      const forbidden = await app.inject({
        method: "PUT",
        url: "/api/pairs/pair/gaps/gap-1",
        headers,
        payload: { status: "integrated", requirements: [] },
      });
      expect(forbidden.statusCode).toBe(400);
      expect(forbidden.json().error).toMatch(/status/i);
      expect((await store.gap("pair", "gap-1")).status).toBe("open");
      const blank = await app.inject({
        method: "POST",
        url: "/api/pairs/pair/gaps/gap-1/approve",
        headers,
        payload: { approvedBy: "   " },
      });
      expect(blank.statusCode).toBe(400);
      expect(blank.json().error).toMatch(/name/i);
      await store.saveSnapshot({
        version: 1,
        id: "snap",
        pairId: "pair",
        createdAt: new Date().toISOString(),
        sourceSha: sha,
        targetSha: sha,
        baselineSha: sha,
        fetchedAt: null,
        offline: true,
        knowledgeHash: "k",
        configHash: "c",
        events: [],
        coverage: { total: 0, assessed: 0, unprocessed: [] },
      });
      await workflow.revisePlan("pair", "gap-1", {
        sourceBehavior: "source",
        targetBehavior: "target",
        targetFiles: ["app.txt"],
        approach: "adapt",
        conventions: [],
        dependencies: [],
        regressionTests: ["check"],
        commands: [],
        manualScenarios: [],
        questions: [],
      });
      await expect(workflow.approve("pair", "gap-1", "Ada")).rejects.toThrow(
        /Setup/,
      );
      const active = jobs.enqueue(
        "validate",
        "pair",
        "gap-1",
        (job) =>
          new Promise((resolve) => {
            job.abort.signal.addEventListener("abort", () => resolve({}));
          }),
      );
      const duplicate = await app.inject({
        method: "POST",
        url: "/api/pairs/pair/gaps/gap-1/implement",
        headers,
      });
      expect(duplicate.statusCode).toBe(400);
      expect(duplicate.json().error).toMatch(/already/);
      const waiting = jobs.enqueue("plan", "pair", "gap-1", async () => ({}));
      expect(waiting.status).toBe("queued");
      jobs.cancel(waiting.id);
      expect(waiting.events.at(-1)).toMatchObject({
        type: "cancelled",
        data: {
          activity: "outcome",
          summary: "Planning cancelled",
          recovery: "Start the action again when you are ready.",
        },
      });
      jobs.cancel(active.id);
      const milestone = validationMilestone({
        index: 0,
        total: 2,
        name: "production build",
        phase: "running",
        completed: 0,
        blocking: true,
      });
      expect(milestone.summary).toBe("Check 1 of 2: production build");
      expect(milestone.progress).not.toHaveProperty("output");
      const normalized = normalizeAgentActivity({
        type: "session/update",
        data: {
          update: {
            sessionUpdate: "tool_call",
            kind: "read",
            locations: [{ path: "src/app.ts" }],
          },
        },
      });
      expect(normalized).toMatchObject({ summary: "Inspecting src/app.ts" });
      expect(JSON.stringify(normalized)).not.toContain("session/update");
    } finally {
      await app.close();
    }
  });
});
