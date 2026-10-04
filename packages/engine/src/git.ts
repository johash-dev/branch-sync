import { spawn } from "node:child_process";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PairConfig } from "./schema.js";

export async function processRun(
  executable: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  onActivity?: (activity: { lastOutputAt: string }) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const npmCli =
      process.env.npm_execpath ||
      path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
    const useNode =
      process.platform === "win32" &&
      executable === "npm" &&
      existsSync(npmCli);
    const child = spawn(
      useNode ? process.execPath : executable,
      useNode ? [npmCli, ...args] : args,
      { cwd, shell: false, windowsHide: true, signal },
    );
    let output = "",
      errors = "",
      lastActivity = 0;
    const noteActivity = () => {
      if (!onActivity) return;
      const at = Date.now();
      if (lastActivity && at - lastActivity < 1000) return;
      lastActivity = at;
      onActivity({ lastOutputAt: new Date(at).toISOString() });
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      noteActivity();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      errors += chunk;
      noteActivity();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output.trimEnd())
        : reject(
            new Error(
              `${executable} ${args.join(" ")} failed (${code}): ${errors.trim() || output.trim()}`,
            ),
          ),
    );
  });
}
export const git = (cwd: string, ...args: string[]) =>
  processRun("git", ["-C", cwd, ...args], cwd);
export async function gitCommonDir(cwd: string): Promise<string> {
  const raw = await git(cwd, "rev-parse", "--git-common-dir");
  return realpath(path.resolve(cwd, raw));
}
export async function remoteIdentity(
  cwd: string,
  remote: string,
): Promise<string> {
  const value = await git(cwd, "remote", "get-url", remote);
  if (/^https?:\/\//.test(value)) {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  }
  return value;
}
export async function resolveCommit(cwd: string, ref: string): Promise<string> {
  return git(cwd, "rev-parse", "--verify", `${ref}^{commit}`);
}
export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(cwd, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch {
    return false;
  }
}
export async function listRefs(cwd: string): Promise<string[]> {
  return (
    await git(
      cwd,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/remotes",
      "refs/heads",
    )
  )
    .split("\n")
    .filter(Boolean);
}
export async function verifyPair(
  pair: PairConfig,
  sourcePath: string,
  targetPath: string,
) {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(targetPath))
    throw new Error("Repository paths must be absolute");
  const [sourceCommon, targetCommon, sourceIdentity, targetIdentity] =
    await Promise.all([
      gitCommonDir(sourcePath),
      gitCommonDir(targetPath),
      remoteIdentity(sourcePath, pair.source.remote),
      remoteIdentity(targetPath, pair.target.remote),
    ]);
  if (pair.source.identity && pair.source.identity !== sourceIdentity)
    throw new Error("Source remote identity changed");
  if (pair.target.identity && pair.target.identity !== targetIdentity)
    throw new Error("Target remote identity changed");
  const [sourceSha, targetSha, baselineSha] = await Promise.all([
    resolveCommit(sourcePath, pair.source.ref),
    resolveCommit(targetPath, pair.target.ref),
    resolveCommit(sourcePath, pair.baseline),
  ]);
  if (!(await isAncestor(sourcePath, baselineSha, sourceSha)))
    throw new Error(
      "Baseline is not an ancestor of the source ref; reconfigure the pair after checking history",
    );
  return {
    sourceCommon,
    targetCommon,
    sourceIdentity,
    targetIdentity,
    sourceSha,
    targetSha,
    baselineSha,
  };
}
export async function changedFiles(cwd: string, parent: string, sha: string) {
  const raw = await git(cwd, "diff", "--name-status", "-z", "-M", parent, sha);
  const parts = raw.split("\0").filter(Boolean);
  const files: { status: string; path: string; previousPath?: string }[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = parts[i++],
        filePath = parts[i++];
      files.push({ status, path: filePath, previousPath });
    } else files.push({ status, path: parts[i++] });
  }
  return files;
}
export async function integrationEvents(
  cwd: string,
  baseline: string,
  source: string,
) {
  const shas = (
    await git(
      cwd,
      "rev-list",
      "--first-parent",
      "--reverse",
      `${baseline}..${source}`,
    )
  )
    .split("\n")
    .filter(Boolean);
  const events = [];
  for (const sha of shas) {
    const [parent, subject, date] = (
      await git(cwd, "show", "-s", "--format=%P%n%s%n%cI", sha)
    ).split("\n");
    const [firstParent, ...otherParents] = parent.split(" ");
    const files = await changedFiles(cwd, firstParent, sha);
    const constituentCommits = otherParents.length
      ? (
          await git(
            cwd,
            "rev-list",
            "--reverse",
            ...otherParents,
            `^${firstParent}`,
          )
        )
          .split("\n")
          .filter(Boolean)
      : [];
    events.push({
      sha,
      parent: firstParent,
      subject,
      date,
      constituentCommits,
      files,
      empty: files.length === 0,
    });
  }
  return events;
}
export async function diffFingerprint(
  cwd: string,
  base: string,
): Promise<string> {
  const { createHash } = await import("node:crypto");
  const [working, staged, untracked] = await Promise.all([
    git(cwd, "diff", "--name-only", "-z", base),
    git(cwd, "diff", "--name-only", "-z", "--cached"),
    git(cwd, "ls-files", "--others", "--exclude-standard", "-z"),
  ]);
  const hash = createHash("sha256");
  for (const file of [
    ...new Set(
      [
        ...working.split("\0"),
        ...staged.split("\0"),
        ...untracked.split("\0"),
      ].filter(Boolean),
    ),
  ].sort()) {
    hash.update(file).update("\0");
    try {
      const full = path.join(cwd, file),
        stat = await lstat(full);
      hash.update(stat.isSymbolicLink() ? "LINK" : "FILE").update("\0");
      hash.update(
        stat.isSymbolicLink() ? await readlink(full) : await readFile(full),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("DELETED");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}
export async function completeDiff(cwd: string, base: string): Promise<string> {
  const tracked = await git(cwd, "diff", "--binary", base);
  const untracked = (
    await git(cwd, "ls-files", "--others", "--exclude-standard", "-z")
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const additions: string[] = [];
  for (const file of untracked) {
    const full = path.join(cwd, file);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) {
      additions.push(
        `Untracked symlink: ${file}\nTarget: ${await readlink(full)}`,
      );
      continue;
    }
    const bytes = await readFile(full);
    let content: string;
    try {
      if (bytes.includes(0)) throw new Error("Binary content");
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      content = `Bytes: ${bytes.length}\nBase64: ${bytes.toString("base64")}`;
    }
    additions.push(`Untracked file: ${file}\n${content}`);
  }
  return [tracked, ...additions].filter(Boolean).join("\n\n");
}
