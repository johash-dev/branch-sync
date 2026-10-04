import { beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const project = process.cwd();
let stub: string;
async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe.skipIf(process.platform !== "win32")("Windows setup launcher", () => {
  beforeAll(async () => {
    await exec(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "-p",
        "packages/server/tsconfig.build.json",
      ],
      { cwd: project, windowsHide: true },
    );
    const folder = await mkdtemp(path.join(tmpdir(), "workbench fake agent "));
    stub = path.join(folder, "agent.exe");
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -Path ${quote(path.join(project, "tests/fixtures/setup-agent.cs"))} -OutputAssembly ${quote(stub)} -OutputType ConsoleApplication`,
      ],
      { windowsHide: true },
    );
  });

  async function fixture(state = "signed-in") {
    const root = await mkdtemp(
      path.join(tmpdir(), "workbench launch with spaces "),
    );
    const local = path.join(root, ".local");
    await mkdir(local);
    await cp(path.join(project, "scripts"), path.join(root, "scripts"), {
      recursive: true,
    });
    await mkdir(path.join(root, "packages/server/src"), { recursive: true });
    await cp(
      path.join(project, "packages/server/src/cursor-auth.ts"),
      path.join(root, "packages/server/src/cursor-auth.ts"),
    );
    await writeFile(path.join(root, "tsconfig.json"), "{}");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "setup-fixture",
        version: "1.0.0",
        type: "module",
        scripts: {
          postinstall: "node scripts/fixture-build.mjs install",
          build: "node scripts/fixture-build.mjs build",
        },
      }),
    );
    await writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({
        name: "setup-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "setup-fixture",
            version: "1.0.0",
            hasInstallScript: true,
          },
        },
      }),
    );
    const appUrl = pathToFileURL(
      path.join(project, "packages/server/dist/app.js"),
    ).href;
    const server = `import { createApp } from ${JSON.stringify(appUrl)}; const {app} = createApp(${JSON.stringify(root)}, () => process.exit(0)); await app.listen({host:'127.0.0.1',port:Number(process.env.SYNC_PORT)});`;
    await writeFile(
      path.join(root, "scripts/fixture-build.mjs"),
      `
      import {mkdirSync, writeFileSync, appendFileSync, existsSync} from 'node:fs';
      const stage = process.argv[2];
      if (stage === 'install') { mkdirSync('node_modules', {recursive:true}); writeFileSync('node_modules/.package-lock.json', '{}'); }
      if (stage === 'build') {
        if (existsSync('.local/fail-build')) throw new Error('Fixture build failed');
        for (const p of ['server','engine','web']) mkdirSync('packages/'+p+'/dist',{recursive:true});
        writeFileSync('packages/server/dist/index.js', ${JSON.stringify(server)});
        writeFileSync('packages/engine/dist/index.js', '');
        writeFileSync('packages/web/dist/index.html', '<h1>Setup fixture</h1>');
      }
      appendFileSync('.local/counts', stage+'\\n');
    `,
    );
    const home = path.join(root, "agent-state");
    await mkdir(home);
    await writeFile(path.join(home, "state"), state);
    const port = await unusedPort();
    const env = {
      ...process.env,
      PATH: `${path.dirname(stub)};${process.env.PATH}`,
      SETUP_TEST_AGENT_HOME: home,
      NODE_OPTIONS: "",
      SYNC_PORT: String(port),
    };
    const run = async (args: string[] = []) => {
      try {
        const result = await exec(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(root, "scripts/setup.ps1"),
            "-NoBrowser",
            ...args,
          ],
          { env, windowsHide: true, timeout: 120_000 },
        );
        return { code: 0, output: result.stdout + result.stderr };
      } catch (e) {
        const error = e as { code: number; stdout: string; stderr: string };
        return { code: error.code, output: error.stdout + error.stderr };
      }
    };
    const runtime = async () =>
      (await fetch(`http://127.0.0.1:${port}/api/runtime`)).json() as Promise<{
        pid: number;
        checkoutId: string;
      }>;
    return { root, local, home, port, run, runtime };
  }

  it("installs/builds once, skips login, reuses its server, and stops safely", async () => {
    const f = await fixture();
    try {
      const first = await f.run();
      expect(first, first.output).toMatchObject({ code: 0 });
      const initial = await f.runtime();
      const second = await f.run();
      expect(second, second.output).toMatchObject({ code: 0 });
      expect((await f.runtime()).pid).toBe(initial.pid);
      expect(await readFile(path.join(f.local, "counts"), "utf8")).toBe(
        "install\nbuild\n",
      );
      expect(
        await readFile(path.join(f.home, "calls.txt"), "utf8"),
      ).not.toContain("login");
      const stopped = await f.run(["-Stop"]);
      expect(stopped, stopped.output).toMatchObject({ code: 0 });
      await expect(f.runtime()).rejects.toThrow();
      expect((await f.run()).code).toBe(0);
      expect((await f.runtime()).pid).not.toBe(initial.pid);
      const beforeChange = await f.runtime();
      await appendFile(
        path.join(f.root, "packages/server/src/cursor-auth.ts"),
        "\n// changed build input\n",
      );
      const updated = await f.run();
      expect(updated, updated.output).toMatchObject({ code: 0 });
      expect((await f.runtime()).pid).not.toBe(beforeChange.pid);
      expect(await readFile(path.join(f.local, "counts"), "utf8")).toBe(
        "install\nbuild\nbuild\n",
      );
    } finally {
      await f.run(["-Stop"]);
    }
  }, 120_000);

  it("logs in only when explicitly signed out, and refuses a concurrent launcher", async () => {
    const f = await fixture("signed-out");
    try {
      await writeFile(path.join(f.home, "slow"), "");
      const first = f.run();
      for (let i = 0; i < 100; i++) {
        const calls = await readFile(
          path.join(f.home, "calls.txt"),
          "utf8",
        ).catch(() => "");
        if (calls.includes("status")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect((await f.run()).output).toContain(
        "Another setup or launcher is running",
      );
      const result = await first;
      expect(result, result.output).toMatchObject({ code: 0 });
      expect(
        (await readFile(path.join(f.home, "calls.txt"), "utf8"))
          .split("\n")
          .filter((s) => s === "login"),
      ).toHaveLength(1);
    } finally {
      await f.run(["-Stop"]);
    }
  }, 120_000);

  it("does not open login on network errors and allows retry after cancelled login", async () => {
    const f = await fixture("unknown");
    expect((await f.run()).output).toContain("sign-in could not be confirmed");
    expect(
      await readFile(path.join(f.home, "calls.txt"), "utf8"),
    ).not.toContain("login");
    await writeFile(path.join(f.home, "state"), "signed-out");
    await writeFile(path.join(f.home, "cancel"), "");
    expect((await f.run()).output).toContain("sign-in was cancelled or failed");
    await writeFile(path.join(f.home, "state"), "signed-in");
    try {
      const result = await f.run();
      expect(result, result.output).toMatchObject({ code: 0 });
    } finally {
      await f.run(["-Stop"]);
    }
  }, 120_000);

  it("leaves an unrelated listener alone and retains an existing provider choice", async () => {
    const f = await fixture();
    const listener = createServer((socket) => {
      socket.on("error", () => {}); // The launcher's port probe may close without reading.
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) =>
      listener.listen(f.port, "127.0.0.1", resolve),
    );
    try {
      const result = await f.run();
      expect(result.code).toBe(1);
      expect(result.output).toContain("is busy");
      expect(listener.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    const binding = {
      version: 1,
      defaultProvider: "claude",
      pairs: {
        existing: { sourcePath: "saved-source", targetPath: "saved-target" },
      },
    };
    await writeFile(
      path.join(f.local, "bindings.json"),
      JSON.stringify(binding),
    );
    try {
      const result = await f.run();
      expect(result, result.output).toMatchObject({ code: 0 });
      expect(
        JSON.parse(await readFile(path.join(f.local, "bindings.json"), "utf8")),
      ).toEqual(binding);
    } finally {
      await f.run(["-Stop"]);
    }
  }, 120_000);

  it("resumes a failed build without repeating dependency installation", async () => {
    const f = await fixture();
    await writeFile(path.join(f.local, "fail-build"), "");
    const failed = await f.run();
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("build failed");
    expect(await readFile(path.join(f.local, "counts"), "utf8")).toBe(
      "install\n",
    );
    await unlink(path.join(f.local, "fail-build"));
    try {
      const retried = await f.run();
      expect(retried, retried.output).toMatchObject({ code: 0 });
      expect(await readFile(path.join(f.local, "counts"), "utf8")).toBe(
        "install\nbuild\n",
      );
    } finally {
      await f.run(["-Stop"]);
    }
  }, 120_000);
});
