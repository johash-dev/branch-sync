import { describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { git, hash, type PairConfig } from "../packages/engine/src/index.js";
import { createApp } from "../packages/server/src/app.js";
import {
  parseCursorStatus,
  resolveCursorCommand,
} from "../packages/server/src/cursor-auth.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workbench setup "));
  const repo = path.join(root, "repo with spaces");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Setup test");
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "remote", "add", "origin", repo);
  await writeFile(path.join(repo, "file.txt"), "baseline");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "baseline");
  await git(repo, "branch", "target");
  const shutdown = vi.fn();
  const { app, store, jobs } = createApp(root, shutdown);
  const pair: PairConfig = {
    version: 1,
    id: "fixture",
    name: "Fixture",
    source: { remote: "origin", identity: repo, ref: "main" },
    target: { remote: "origin", identity: repo, ref: "target" },
    baseline: await git(repo, "rev-parse", "HEAD"),
    rules: ["Keep existing behavior"],
    mappings: [{ source: "file.txt", target: "file.txt", note: "same" }],
    intentionalDifferences: [],
    validation: {
      install: null,
      build: { executable: "node", args: ["--version"] },
      tests: [],
      manual: [],
    },
  };
  await store.savePair(pair);
  const token = (await app.inject("/api/session")).json().token;
  const selection = {
    pairId: pair.id,
    sourcePath: repo,
    targetPath: repo,
    sourceRef: "main",
    targetRef: "target",
    pairHash: hash(pair),
  };
  const post = (
    endpoint: string,
    payload: Record<string, unknown> = selection,
  ) =>
    app.inject({
      method: "POST",
      url: endpoint,
      headers: { "x-sync-token": token },
      payload,
    });
  return { root, repo, pair, app, store, jobs, shutdown, post, selection };
}

describe("Cursor sign-in detection", () => {
  it.each([
    ["✓ Logged in as developer@example.invalid", "authenticated"],
    ["\u001b[32mAuthenticated\u001b[0m", "authenticated"],
    ["Not authenticated. Run agent login", "unauthenticated"],
    ["Status: not logged in", "unauthenticated"],
    ["Authenticated: false", "unauthenticated"],
    ["Could not fetch authenticated user: network error", "unknown"],
    ["An unfamiliar status format", "unknown"],
  ])("handles %s", (input, expected) =>
    expect(parseCursorStatus(input)).toBe(expected),
  );
});

describe("Cursor CLI resolution", () => {
  it("prefers agent.exe on PATH and otherwise uses the newest versioned launcher", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor cli "));
    const bin = path.join(root, "bin");
    const install = path.join(root, "install");
    const older = path.join(install, "versions", "2026.01.02-aaaa");
    const newer = path.join(install, "versions", "2026.09.28-01-02-03-bbbb");
    await mkdir(bin, { recursive: true });
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    await writeFile(path.join(bin, "agent.exe"), "");
    for (const directory of [older, newer]) {
      await writeFile(path.join(directory, "node.exe"), "");
      await writeFile(path.join(directory, "index.js"), "");
    }
    expect(
      resolveCursorCommand(["status"], {
        platform: "win32",
        pathEnv: `${bin}${path.delimiter}${install}`,
        installRoot: install,
      }),
    ).toEqual({ file: path.join(bin, "agent.exe"), args: ["status"] });
    expect(
      resolveCursorCommand(["acp"], {
        platform: "win32",
        pathEnv: install,
        installRoot: install,
      }),
    ).toEqual({
      file: path.join(newer, "node.exe"),
      args: [path.join(newer, "index.js"), "acp"],
    });
  });
});

describe("guided setup API", () => {
  it("discovers and validates the same checkout and a worktree without saving bindings", async () => {
    const f = await fixture();
    try {
      const inspect = await f.post("/api/setup/inspect");
      expect(inspect.statusCode).toBe(200);
      expect(inspect.json().source).toEqual(["main", "target"]);
      expect((await f.post("/api/setup/validate")).statusCode).toBe(200);
      const worktree = path.join(f.root, "target worktree");
      await git(f.repo, "worktree", "add", worktree, "target");
      expect(
        (
          await f.post("/api/setup/validate", {
            ...f.selection,
            targetPath: worktree,
          })
        ).statusCode,
      ).toBe(200);
      await expect(
        access(path.join(f.root, ".local", "bindings.json")),
      ).rejects.toThrow();
      expect(await f.store.pair("fixture")).toEqual(f.pair);
    } finally {
      await f.app.close();
    }
  });

  it("rejects invalid folders, remotes, missing branches, and missing baselines before saving", async () => {
    const f = await fixture();
    try {
      for (const selection of [
        { ...f.selection, sourcePath: "relative" },
        { ...f.selection, sourcePath: f.root },
        { ...f.selection, sourceRef: "missing-branch" },
      ])
        expect(
          (await f.post("/api/setup/complete", selection)).statusCode,
        ).toBe(400);
      await f.store.savePair({ ...f.pair, baseline: "a".repeat(40) });
      expect((await f.post("/api/setup/validate")).statusCode).toBe(400);
      await f.store.savePair(f.pair);
      await git(
        f.repo,
        "remote",
        "set-url",
        "origin",
        "https://example.invalid/wrong.git",
      );
      expect((await f.post("/api/setup/validate")).json().error).toContain(
        "identity",
      );
      expect((await f.store.binding()).pairs).toEqual({});
    } finally {
      await f.app.close();
    }
  });

  it("preserves provider and other bindings, leaves unchanged presets alone, and acknowledges shared edits", async () => {
    const f = await fixture();
    try {
      await f.store.saveBinding({
        version: 1,
        defaultProvider: "claude",
        pairs: {
          other: { sourcePath: "other-source", targetPath: "other-target" },
        },
      });
      const invalidate = vi.spyOn(f.store, "invalidatePair");
      expect((await f.post("/api/setup/complete")).statusCode).toBe(200);
      expect(invalidate).not.toHaveBeenCalled();
      const changed = { ...f.selection, targetRef: "main" };
      expect(
        (await f.post("/api/setup/complete", changed)).json().error,
      ).toContain("Acknowledge");
      const saved = await f.post("/api/setup/complete", {
        ...changed,
        acknowledge: true,
      });
      expect(saved.statusCode).toBe(200);
      expect(invalidate).toHaveBeenCalledWith("fixture");
      expect(await f.store.pair("fixture")).toEqual({
        ...f.pair,
        target: { ...f.pair.target, ref: "main" },
      });
      expect(await f.store.binding()).toMatchObject({
        defaultProvider: "claude",
        pairs: {
          other: { sourcePath: "other-source" },
          fixture: { sourcePath: f.repo, targetPath: f.repo },
        },
      });
      expect(
        (
          await f.post("/api/setup/complete", {
            ...changed,
            pairHash: saved.json().pairHash,
          })
        ).statusCode,
      ).toBe(200);
      expect((await f.post("/api/setup/complete")).json().error).toContain(
        "settings changed",
      );
    } finally {
      await f.app.close();
    }
  });

  it("protects setup and shutdown actions, reports checkout identity, and refuses shutdown during jobs", async () => {
    const f = await fixture();
    try {
      for (const endpoint of ["folder", "inspect", "validate", "complete"]) {
        expect(
          (
            await f.app.inject({
              method: "POST",
              url: `/api/setup/${endpoint}`,
              payload: f.selection,
            })
          ).statusCode,
        ).toBe(403);
      }
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/setup/complete",
            headers: { origin: "https://example.invalid" },
            payload: f.selection,
          })
        ).statusCode,
      ).toBe(403);
      const runtime = (await f.app.inject("/api/runtime")).json();
      expect(runtime).toMatchObject({
        application: "branch-sync-workbench",
        pid: process.pid,
        activeJobs: 0,
        canStop: true,
      });
      expect(runtime.checkoutId).toMatch(/^[a-f0-9]{64}$/);
      f.jobs.all.set("active", {
        id: "active",
        kind: "analyze",
        pairId: "fixture",
        status: "running",
        events: [],
        interactions: [],
        abort: new AbortController(),
      });
      expect((await f.post("/api/runtime/stop", {})).json().error).toContain(
        "active jobs",
      );
      expect(f.shutdown).not.toHaveBeenCalled();
      f.jobs.all.clear();
      expect((await f.post("/api/runtime/stop", {})).statusCode).toBe(200);
      expect((await f.post("/api/setup/complete")).statusCode).toBe(503);
      await vi.waitFor(() => expect(f.shutdown).toHaveBeenCalledOnce());
    } finally {
      await f.app.close();
    }
  });
});
