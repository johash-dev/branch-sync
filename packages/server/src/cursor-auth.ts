import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export type CursorCommand = { file: string; args: string[] };

const versionPattern =
  /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/;

function versionRank(name: string): number {
  const match = versionPattern.exec(name);
  if (!match) return 0;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] =
    match;
  return Number(
    `${year}${month.padStart(2, "0")}${day.padStart(2, "0")}${hour}${minute}${second}`,
  );
}

function executableOnPath(pathEnv: string, name: string): string | undefined {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function versionedLauncher(installRoot: string): CursorCommand | undefined {
  const versions = path.join(installRoot, "versions");
  if (!existsSync(versions)) return undefined;
  const version = readdirSync(versions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && versionPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => versionRank(b) - versionRank(a) || b.localeCompare(a))[0];
  if (!version) return undefined;
  const directory = path.join(versions, version);
  const node = path.join(directory, "node.exe");
  const index = path.join(directory, "index.js");
  if (!existsSync(node) || !existsSync(index)) return undefined;
  return { file: node, args: [index] };
}

export function resolveCursorCommand(
  extraArgs: string[],
  options: {
    platform?: NodeJS.Platform;
    pathEnv?: string;
    installRoot?: string;
  } = {},
): CursorCommand {
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const executable = executableOnPath(
    pathEnv,
    platform === "win32" ? "agent.exe" : "agent",
  );
  if (executable) return { file: executable, args: extraArgs };
  if (platform === "win32") {
    const installRoot =
      options.installRoot ??
      (process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "cursor-agent")
        : "");
    const launcher = installRoot ? versionedLauncher(installRoot) : undefined;
    if (launcher)
      return { file: launcher.file, args: [...launcher.args, ...extraArgs] };
  }
  return { file: "agent", args: extraArgs };
}

export type Authentication = "authenticated" | "unauthenticated" | "unknown";

export function parseCursorStatus(output: string): Authentication {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (
    /^\s*(?:[✓✔●✗✘]\s*)?(?:status:\s*)?(?:not authenticated|not logged in|not signed in|logged out|unauthenticated|authenticated:\s*false)\b/im.test(
      text,
    )
  )
    return "unauthenticated";
  if (
    /^\s*(?:[✓✔●]\s*)?(?:status:\s*)?(?:authenticated|logged in|signed in|login successful)(?:\s+as\b|:\s*true\b|[.!]?\s*$)/im.test(
      text,
    )
  )
    return "authenticated";
  return "unknown";
}

export async function cursorAuthentication(
  cwd: string,
): Promise<Authentication> {
  try {
    const command = resolveCursorCommand(["status"]);
    const { stdout } = await promisify(execFile)(command.file, command.args, {
      cwd,
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 256_000,
    });
    return parseCursorStatus(stdout);
  } catch (error) {
    // Only an explicit signed-out response warrants a login. Network/process
    // errors must never trigger repeated browser authentication.
    const failure = error as { stdout?: string; stderr?: string };
    return parseCursorStatus(
      `${failure.stdout || ""}\n${failure.stderr || ""}`,
    ) === "unauthenticated"
      ? "unauthenticated"
      : "unknown";
  }
}
