import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import {
  openWorktree,
  resolveEditorCommand,
  type EditorLauncher,
} from "../packages/server/src/editor.js";

const worktree = "D:\\wt\\gap";

describe("editor resolution", () => {
  it("prefers known Windows installs and ignores command shims", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "editor install "));
    const cursor = path.win32.join(root, "Programs", "cursor", "Cursor.exe");
    const pathCursor = path.win32.join(root, "bin", "Cursor.exe");
    const code = path.win32.join(
      root,
      "Program Files",
      "Microsoft VS Code",
      "Code.exe",
    );
    const shim = path.win32.join(root, "bin", "code.cmd");
    await mkdir(path.win32.dirname(cursor), { recursive: true });
    await mkdir(path.win32.dirname(pathCursor), { recursive: true });
    await mkdir(path.win32.dirname(code), { recursive: true });
    await writeFile(cursor, "");
    await writeFile(pathCursor, "");
    await writeFile(code, "");
    await writeFile(shim, "");
    const env = {
      LOCALAPPDATA: root,
      ProgramFiles: path.win32.join(root, "Program Files"),
      "ProgramFiles(x86)": "",
      PATH: path.win32.join(root, "bin"),
    };
    expect(resolveEditorCommand("cursor", worktree, {
      platform: "win32",
      env,
      exists: existsSync,
    })).toEqual({ file: cursor, args: [worktree] });
    expect(resolveEditorCommand("code", worktree, {
      platform: "win32",
      env,
      exists: existsSync,
    })).toEqual({ file: code, args: [worktree] });
  });

  it("uses the Windows executable on PATH when no install location exists", () => {
    expect(
      resolveEditorCommand("code", worktree, {
        platform: "win32",
        env: {
          LOCALAPPDATA: "",
          ProgramFiles: "",
          "ProgramFiles(x86)": "",
          PATH: "C:\\tools",
        },
        exists: (file) => file === "C:\\tools\\Code.exe",
      }).file,
    ).toBe("C:\\tools\\Code.exe");
    expect(() =>
      resolveEditorCommand("cursor", worktree, {
        platform: "win32",
        env: { PATH: "C:\\tools" },
        exists: (file) => file.endsWith("cursor.cmd"),
      }),
    ).toThrow(/Install Cursor/);
  });

  it("launches the resolved executable directly and reports spawn failures", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const launch = vi.fn((() => child) as unknown as EditorLauncher);
    const opened = openWorktree("cursor", worktree, {
      platform: "win32",
      env: { PATH: "C:\\Editors" },
      exists: (file) => file === "C:\\Editors\\Cursor.exe",
      spawn: launch,
    });
    setImmediate(() => child.emit("spawn"));
    await expect(opened).resolves.toEqual({
      opened: true,
      editor: "cursor",
      worktree,
    });
    expect(launch).toHaveBeenCalledWith("C:\\Editors\\Cursor.exe", [worktree], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    expect(child.unref).toHaveBeenCalled();

    const failing = new EventEmitter() as EventEmitter & { unref: () => void };
    failing.unref = vi.fn();
    const failLaunch = vi.fn((() => {
      setImmediate(() => failing.emit("error", new Error("ENOENT")));
      return failing;
    }) as unknown as EditorLauncher);
    await expect(
      openWorktree("code", worktree, {
        platform: "win32",
        env: { PATH: "C:\\Editors" },
        exists: (file) => file === "C:\\Editors\\Code.exe",
        spawn: failLaunch,
      }),
    ).rejects.toThrow(
      "VS Code could not open the worktree (ENOENT). Use the worktree path to open it manually.",
    );
  });
});
