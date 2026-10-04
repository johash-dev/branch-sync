import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { Store, git, listRefs, verifyPair, hash } from "@sync/engine";

const selection = z.object({
  pairId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  sourcePath: z.string().min(1),
  targetPath: z.string().min(1),
  sourceRef: z.string().min(1).optional(),
  targetRef: z.string().min(1).optional(),
});

export async function inspectSelection(
  store: Store,
  input: unknown,
  validate = false,
) {
  const value = selection.parse(input);
  const pair = await store.pair(value.pairId);
  for (const [label, directory] of [
    ["Source", value.sourcePath],
    ["Target", value.targetPath],
  ]) {
    if (!path.isAbsolute(directory))
      throw new Error(`${label}: choose an absolute repository path.`);
    try {
      if (
        (await git(directory, "rev-parse", "--is-inside-work-tree")) !== "true"
      )
        throw new Error();
    } catch {
      throw new Error(`${label}: choose an existing Git checkout or worktree.`);
    }
  }
  const [source, target] = await Promise.all([
    listRefs(value.sourcePath),
    listRefs(value.targetPath),
  ]);
  if (validate) {
    pair.source.ref = value.sourceRef || pair.source.ref;
    pair.target.ref = value.targetRef || pair.target.ref;
    await verifyPair(pair, value.sourcePath, value.targetPath);
  }
  return {
    source,
    target,
    valid: validate,
    pairHash: hash(await store.pair(value.pairId)),
  };
}

export function registerSetup(
  app: FastifyInstance,
  store: Store,
  root: string,
) {
  let picking = false;
  app.post("/api/setup/folder", async () => {
    if (process.platform !== "win32")
      throw new Error("Enter the absolute folder path on this platform.");
    if (picking)
      throw new Error(
        "A folder picker is already open. Choose a folder or cancel it.",
      );
    picking = true;
    try {
      const { stdout } = await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-STA",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(root, "scripts", "choose-folder.ps1"),
        ],
        { windowsHide: true, timeout: 300_000, maxBuffer: 64_000 },
      );
      return { path: stdout.trim() || null };
    } catch {
      throw new Error(
        "Folder picker could not complete. Retry Browse or enter the absolute path.",
      );
    } finally {
      picking = false;
    }
  });
  app.post("/api/setup/inspect", async (req) =>
    inspectSelection(store, req.body),
  );
  app.post("/api/setup/validate", async (req) =>
    inspectSelection(store, req.body, true),
  );
  app.post("/api/setup/complete", async (req) => {
    const value = selection
      .extend({
        sourceRef: z.string().min(1),
        targetRef: z.string().min(1),
        pairHash: z.string(),
        acknowledge: z.boolean().default(false),
      })
      .parse(req.body);
    await inspectSelection(store, value, true);
    const pair = await store.pair(value.pairId);
    if (hash(pair) !== value.pairHash)
      throw new Error(
        "Pair settings changed. Go back and check the branches again.",
      );
    const changed =
      pair.source.ref !== value.sourceRef ||
      pair.target.ref !== value.targetRef;
    if (changed && !value.acknowledge)
      throw new Error("Acknowledge the shared branch changes before saving.");
    if (changed) {
      pair.source.ref = value.sourceRef;
      pair.target.ref = value.targetRef;
      await store.savePair(pair);
    }
    const binding = await store.binding();
    binding.pairs[pair.id] = {
      sourcePath: value.sourcePath,
      targetPath: value.targetPath,
    };
    await store.saveBinding(binding);
    return { saved: true, pairHash: hash(pair) };
  });
}
