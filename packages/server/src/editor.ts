import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type EditorId = "cursor" | "code";
export type EditorCommand = { file: string; args: string[] };

type Exists = (file: string) => boolean;
type LaunchedProcess = {
  once(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  unref(): void;
};
export type EditorLauncher = (
  file: string,
  args: string[],
  options: {
    detached: true;
    stdio: "ignore";
    windowsHide: true;
    shell: false;
  },
) => LaunchedProcess;

export type EditorLaunchOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: Exists;
  spawn?: EditorLauncher;
};

const editorName: Record<EditorId, string> = {
  cursor: "Cursor",
  code: "VS Code",
};

function joinFor(platform: NodeJS.Platform, ...parts: string[]) {
  return (platform === "win32" ? path.win32 : path.posix).join(...parts);
}

function present(value: string | undefined) {
  return value || "";
}

function windowsCandidates(editor: EditorId, env: NodeJS.ProcessEnv) {
  const local = present(env.LOCALAPPDATA);
  const programFiles = present(env.ProgramFiles);
  const programFilesX86 = present(env["ProgramFiles(x86)"]);
  if (editor === "cursor")
    return [
      local && joinFor("win32", local, "Programs", "cursor", "Cursor.exe"),
      programFiles && joinFor("win32", programFiles, "cursor", "Cursor.exe"),
      programFilesX86 &&
        joinFor("win32", programFilesX86, "cursor", "Cursor.exe"),
    ].filter((candidate): candidate is string => !!candidate);
  return [
    local &&
      joinFor("win32", local, "Programs", "Microsoft VS Code", "Code.exe"),
    programFiles &&
      joinFor("win32", programFiles, "Microsoft VS Code", "Code.exe"),
    programFilesX86 &&
      joinFor("win32", programFilesX86, "Microsoft VS Code", "Code.exe"),
  ].filter((candidate): candidate is string => !!candidate);
}

function knownCandidates(
  editor: EditorId,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) {
  if (platform === "win32") return windowsCandidates(editor, env);
  if (platform === "darwin")
    return [
      editor === "cursor"
        ? "/Applications/Cursor.app/Contents/MacOS/Cursor"
        : "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    ];
  return [];
}

function pathCandidates(
  editor: EditorId,
  platform: NodeJS.Platform,
  pathEnv: string,
) {
  const name =
    platform === "win32"
      ? editor === "cursor"
        ? "Cursor.exe"
        : "Code.exe"
      : editor === "cursor"
        ? "cursor"
        : "code";
  const delimiter = platform === "win32" ? path.win32.delimiter : path.posix.delimiter;
  return pathEnv
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => joinFor(platform, directory, name));
}

export function missingEditorMessage(editor: EditorId) {
  return editor === "cursor"
    ? "Could not find Cursor on this machine. Install Cursor, then try Open in Cursor again."
    : "Could not find VS Code on this machine. Install Visual Studio Code, then try Open in VS Code again.";
}

export function resolveEditorCommand(
  editor: EditorId,
  worktree: string,
  options: EditorLaunchOptions = {},
): EditorCommand {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const file = [
    ...knownCandidates(editor, platform, env),
    ...pathCandidates(editor, platform, env.PATH || ""),
  ].find((candidate) => exists(candidate));
  if (!file) throw new Error(missingEditorMessage(editor));
  return { file, args: [worktree] };
}

function launchError(editor: EditorId, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `${editorName[editor]} could not open the worktree (${detail}). Use the worktree path to open it manually.`,
  );
}

export async function openWorktree(
  editor: EditorId,
  worktree: string,
  options: EditorLaunchOptions = {},
) {
  const command = resolveEditorCommand(editor, worktree, options);
  const start = options.spawn ?? (spawn as unknown as EditorLauncher);
  let child: LaunchedProcess;
  try {
    child = start(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    throw launchError(editor, error);
  }
  await new Promise<void>((resolve, reject) => {
    const fail = (error?: unknown) => {
      cleanup();
      reject(launchError(editor, error));
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      child.off("error", fail);
      child.off("spawn", ready);
    };
    child.once("error", fail);
    child.once("spawn", ready);
  });
  child.unref();
  return { opened: true as const, editor, worktree };
}
