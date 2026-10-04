import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { processRun } from "@sync/engine";
import { agentReplyExcerpt, hasAgentJson } from "./agent-json.js";
import { cursorAuthentication, resolveCursorCommand } from "./cursor-auth.js";

type Message = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
};
export type ProviderName = "codex" | "cursor" | "claude";
export function selectedProvider(binding: {
  defaultProvider: ProviderName;
}): ProviderName {
  return binding.defaultProvider;
}
export type Role = "analyst" | "planner" | "implementer" | "reviewer";
export const cursorAcpLaunchArgs = ["--model", "grok-4.7-high", "acp"];
export type AgentEvent = { type: string; data: unknown };
export type Interaction = (type: string, params: unknown) => Promise<unknown>;
export type NormalizedActivity =
  | { ignore: true }
  | {
      ignore?: false;
      activity: "operation" | "technical";
      summary?: string;
      subject?: string;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
}
function firstPath(record: Record<string, unknown> | undefined) {
  if (!record) return;
  const locations = record.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const path = firstString(asRecord(location)?.path);
      if (path) return path.replace(/\\/g, "/");
    }
  }
  const changes = record.changes;
  if (Array.isArray(changes)) {
    for (const change of changes) {
      const path = firstString(asRecord(change)?.path);
      if (path) return path.replace(/\\/g, "/");
    }
  }
  const raw = asRecord(record.rawInput);
  return firstString(record.path, raw?.path, raw?.file_path)?.replace(
    /\\/g,
    "/",
  );
}
function commandSubject(value: string) {
  const line = value.split(/\r?\n/, 1)[0]?.trim() || "";
  return line.slice(0, 80);
}
function describeOperation(record: Record<string, unknown> | undefined) {
  if (!record) return;
  const kind = `${record.kind || ""} ${record.type || ""} ${record.title || ""}`.toLowerCase();
  const path = firstPath(record);
  const raw = asRecord(record.rawInput);
  const command = firstString(record.command, raw?.command, record.title);
  if (path && /read|inspect|open|search|list|glob|grep/.test(kind))
    return { summary: `Inspecting ${path}`, subject: path };
  if (path && /edit|write|patch|delete|create|filechange|file_change/.test(kind))
    return { summary: `Editing ${path}`, subject: path };
  if (command && /execute|shell|terminal|bash|command|run/.test(kind)) {
    const subject = commandSubject(command);
    return { summary: `Running ${subject}`, subject };
  }
  if (path && /edit|write|file/.test(String(record.type || "").toLowerCase()))
    return { summary: `Editing ${path}`, subject: path };
  if (path) return { summary: `Working on ${path}`, subject: path };
  return;
}
/** Map provider protocol events to workbench language. Protocol names stay out of summaries. */
export function normalizeAgentActivity(event: AgentEvent): NormalizedActivity {
  if (event.type === "text") return { ignore: true };
  const data = asRecord(event.data);
  if (event.type === "session/update") {
    const update = asRecord(data?.update) || data;
    const sessionUpdate = String(update?.sessionUpdate || "");
    if (
      sessionUpdate === "agent_message_chunk" ||
      sessionUpdate === "agent_thought_chunk"
    )
      return { ignore: true };
    const operation = describeOperation(update);
    if (operation)
      return { activity: "operation", ...operation };
    return { activity: "technical" };
  }
  const item = asRecord(data?.item);
  if (item && event.type.startsWith("item/")) {
    if (item.type === "agentMessage") return { ignore: true };
    const operation = describeOperation({
      ...item,
      kind: item.type,
      title: item.command || item.title,
    });
    if (operation) return { activity: "operation", ...operation };
    return { activity: "technical" };
  }
  if (event.type === "assistant" || event.type === "result" || event.type === "system" || event.type === "stderr")
    return { activity: "technical" };
  const tool = asRecord(data?.tool_use) || (data?.type === "tool_use" ? data : undefined);
  if (tool) {
    const operation = describeOperation(tool);
    if (operation) return { activity: "operation", ...operation };
  }
  return { activity: "technical" };
}
class RpcProcess {
  private child: ChildProcessWithoutNullStreams;
  private next = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  onMessage: (message: Message) => void = () => {};
  onExit: (error: Error) => void = () => {};
  constructor(
    command: string,
    args: string[],
    cwd: string,
    signal: AbortSignal,
    withHeader: boolean,
  ) {
    this.child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let msg: Message;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          msg.error
            ? waiter.reject(new Error(msg.error.message))
            : waiter.resolve(msg.result);
          return;
        }
      }
      this.onMessage(msg);
    });
    let stderr = "";
    this.child.stderr
      .setEncoding("utf8")
      .on("data", (chunk) => (stderr += chunk));
    this.child.on("exit", (code) => {
      const error = new Error(
        `${command} exited (${code}): ${stderr.slice(-1000)}`,
      );
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
      this.onExit(error);
    });
    this.child.on("error", (error) => {
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    });
    signal.addEventListener(
      "abort",
      () => setTimeout(() => this.child.kill(), 2000).unref(),
      { once: true },
    );
    this.withHeader = withHeader;
  }
  private withHeader: boolean;
  send(message: Message) {
    this.child.stdin.write(
      JSON.stringify(
        this.withHeader ? { jsonrpc: "2.0", ...message } : message,
      ) + "\n",
    );
  }
  request(method: string, params: unknown): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
  response(id: number, result: unknown) {
    this.send({ id, result });
  }
  notify(method: string, params: unknown) {
    this.send({ method, params });
  }
  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}
export async function probeProvider(provider: ProviderName, cwd: string) {
  const binary =
    provider === "codex" ? "codex" : provider === "cursor" ? "agent" : "claude";
  try {
    const versionCommand =
      provider === "cursor"
        ? resolveCursorCommand(["--version"])
        : { file: binary, args: ["--version"] };
    const version = await processRun(
      versionCommand.file,
      versionCommand.args,
      cwd,
      AbortSignal.timeout(20_000),
    );
    if (provider === "claude") {
      const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
      if (
        !match ||
        Number(match[1]) < 2 ||
        (Number(match[1]) === 2 &&
          (Number(match[2]) < 1 ||
            (Number(match[2]) === 1 && Number(match[3]) < 199)))
      )
        throw new Error("Claude Code 2.1.199 or later required");
      const help = await processRun(
        binary,
        ["--help"],
        cwd,
        AbortSignal.timeout(20_000),
      );
      if (
        !help.includes("--permission-prompt-tool") ||
        !help.includes("stream-json")
      )
        throw new Error("Required permission and streaming flags unavailable");
      return { provider, available: true, version };
    }
    const helpCommand =
      provider === "cursor"
        ? resolveCursorCommand(["acp", "--help"])
        : {
            file: binary,
            args:
              provider === "codex"
                ? ["app-server", "--help"]
                : ["acp", "--help"],
          };
    const help = await processRun(
      helpCommand.file,
      helpCommand.args,
      cwd,
      AbortSignal.timeout(20_000),
    );
    if (!help.toLowerCase().includes(provider === "codex" ? "stdio" : "acp"))
      throw new Error("Required stdio protocol unavailable");
    return {
      provider,
      available: true,
      version,
      ...(provider === "cursor"
        ? { authentication: await cursorAuthentication(cwd) }
        : {}),
    };
  } catch (error) {
    return { provider, available: false, error: String(error) };
  }
}
export function cursorAcpResponse(type: string, answer: unknown) {
  if (type === "session/request_permission") {
    const optionId =
      typeof answer === "string"
        ? answer
        : (answer as { optionId?: string })?.optionId;
    return { outcome: { outcome: "selected", optionId } };
  }
  if (type === "cursor/ask_question") {
    const value = answer as {
      skipped?: boolean;
      answers?:
        | { questionId: string; selectedOptionIds: string[] }[]
        | Record<string, string | string[]>;
    };
    if (answer === "skip" || value?.skipped)
      return { outcome: { outcome: "skipped" } };
    const answers = Array.isArray(value?.answers)
      ? value.answers
      : value?.answers && typeof value.answers === "object"
        ? Object.entries(value.answers).map(([questionId, selected]) => ({
            questionId,
            selectedOptionIds: (Array.isArray(selected)
              ? selected
              : [selected]
            ).map(String),
          }))
        : [];
    return { outcome: { outcome: "answered", answers } };
  }
  if (type === "cursor/create_plan") {
    const value = answer as { decision?: string; reason?: string };
    if (answer === "accepted" || value?.decision === "accepted")
      return { outcome: { outcome: "accepted" } };
    return {
      outcome: {
        outcome: "rejected",
        reason: value?.reason || "Developer rejected the plan",
      },
    };
  }
  return undefined;
}
function assertCursorTurn(result: { stopReason?: string }, transcript: string) {
  const reason = result?.stopReason;
  if (!reason || reason === "end_turn") return;
  if (reason === "cancelled") throw new Error("Cursor session cancelled");
  throw new Error(
    `Cursor session stopped (${reason}): ${agentReplyExcerpt(transcript)}`,
  );
}
export async function runAgent(
  provider: ProviderName,
  role: Role,
  prompt: string,
  cwd: string,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
  ask: Interaction,
): Promise<{ session: string; text: string }> {
  if (provider === "codex")
    return runCodex(role, prompt, cwd, signal, emit, ask);
  if (provider === "cursor")
    return runCursor(role, prompt, cwd, signal, emit, ask);
  return runClaude(role, prompt, cwd, signal, emit, ask);
}
async function runCodex(
  role: Role,
  prompt: string,
  cwd: string,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
  ask: Interaction,
) {
  const rpc = new RpcProcess("codex", ["app-server"], cwd, signal, false);
  let text = "",
    threadId = "",
    turnId = "";
  let finish: (value: any) => void = () => {},
    fail: (error: Error) => void = () => {};
  const completed = new Promise<any>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  rpc.onExit = fail;
  rpc.onMessage = (message) => {
    if (message.id !== undefined && message.method) {
      void ask(message.method, message.params)
        .then((answer) => rpc.response(message.id!, answer))
        .catch(() => rpc.response(message.id!, { decision: "decline" }));
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = message.params?.delta || "";
      text += delta;
      emit({ type: "text", data: delta });
    } else if (
      message.method === "item/completed" &&
      message.params?.item?.type === "agentMessage"
    ) {
      text = message.params.item.text || text;
    } else if (message.method === "turn/completed")
      finish(message.params?.turn);
    else if (message.method === "error")
      fail(new Error(message.params?.error?.message || "Codex error"));
    else if (message.method)
      emit({ type: message.method, data: message.params });
  };
  try {
    await rpc.request("initialize", {
      clientInfo: {
        name: "branch_sync_workbench",
        title: "Branch Sync Workbench",
        version: "0.1.0",
      },
    });
    rpc.notify("initialized", {});
    const thread = await rpc.request("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      sandbox: role === "implementer" ? "workspace-write" : "read-only",
    });
    threadId = thread.thread.id;
    const turn = await rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd,
      approvalPolicy: "on-request",
      sandboxPolicy:
        role === "implementer"
          ? {
              type: "workspaceWrite",
              writableRoots: [cwd],
              networkAccess: false,
            }
          : { type: "readOnly" },
    });
    turnId = turn.turn.id;
    signal.addEventListener(
      "abort",
      () => {
        void rpc
          .request("turn/interrupt", { threadId, turnId })
          .catch(() => {});
      },
      { once: true },
    );
    const result = await completed;
    if (result.status !== "completed")
      throw new Error(
        `Codex turn ${result.status}: ${result.error?.message || ""}`,
      );
    return { session: threadId, text };
  } finally {
    rpc.close();
  }
}
async function runCursor(
  role: Role,
  prompt: string,
  cwd: string,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
  ask: Interaction,
) {
  const command = resolveCursorCommand(cursorAcpLaunchArgs);
  const rpc = new RpcProcess(command.file, command.args, cwd, signal, true);
  let text = "",
    sessionId = "";
  rpc.onMessage = (message) => {
    if (message.id !== undefined && message.method) {
      void ask(message.method, message.params)
        .then((answer) => rpc.response(message.id!, answer))
        .catch(() =>
          rpc.response(message.id!, { outcome: { outcome: "cancelled" } }),
        );
      return;
    }
    if (message.method === "session/update") {
      const update = message.params?.update;
      if (
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.text
      ) {
        text += update.content.text;
        emit({ type: "text", data: update.content.text });
      } else emit({ type: "session/update", data: update });
    } else if (message.method)
      emit({ type: message.method, data: message.params });
  };
  try {
    await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "branch-sync-workbench", version: "0.1.0" },
    });
    await rpc.request("authenticate", { methodId: "cursor_login" });
    const session = await rpc.request("session/new", { cwd, mcpServers: [] });
    sessionId = session.sessionId;
    if (role !== "implementer")
      await rpc.request("session/set_mode", { sessionId, modeId: "ask" });
    signal.addEventListener(
      "abort",
      () => rpc.notify("session/cancel", { sessionId }),
      { once: true },
    );
    const promptCursor = async (textPrompt: string) => {
      const result = await rpc.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: textPrompt }],
      });
      assertCursorTurn(result, text);
      return result;
    };
    await promptCursor(prompt);
    if (role !== "implementer" && !hasAgentJson(text))
      await promptCursor(
        "The previous reply was not a JSON object. Return only the JSON object required by the original instructions. No preamble.",
      );
    return { session: sessionId, text };
  } finally {
    rpc.close();
  }
}

async function runClaude(
  role: Role,
  prompt: string,
  cwd: string,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
  ask: Interaction,
): Promise<{ session: string; text: string }> {
  const secret = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    if (
      req.method !== "POST" ||
      req.url !== "/decision" ||
      req.headers["x-sync-bridge-token"] !== secret
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const answer = (await ask("claude/permission", input)) as any;
      const choice = typeof answer === "string" ? answer : answer?.behavior;
      const decision =
        choice === "allow"
          ? { behavior: "allow", updatedInput: input.input || {} }
          : {
              behavior: "deny",
              message: answer?.message || "Developer denied permission",
            };
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(decision));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(0, "127.0.0.1", () => resolve()).once("error", reject),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Permission bridge address unavailable");
  const config = {
    mcpServers: {
      sync_permission: {
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL("../dist/claude-permission-bridge.js", import.meta.url),
          ),
        ],
        env: {
          SYNC_PERMISSION_ENDPOINT: `http://127.0.0.1:${address.port}/decision`,
          SYNC_PERMISSION_TOKEN: secret,
        },
      },
    },
  };
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    role === "implementer" ? "default" : "plan",
    "--mcp-config",
    JSON.stringify(config),
    "--permission-prompt-tool",
    "mcp__sync_permission__approve",
  ];
  const child = spawn("claude", args, {
    cwd,
    windowsHide: true,
    shell: false,
    env: process.env,
  });
  let output = "",
    stderr = "",
    session = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    emit({ type: "stderr", data: chunk });
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      emit({ type: message.type || "event", data: message });
      if (message.type === "result") {
        output = message.result || output;
        session = message.session_id || session;
      } else if (message.type === "assistant") {
        const text = (message.message?.content || [])
          .filter((x: any) => x.type === "text")
          .map((x: any) => x.text)
          .join("");
        if (text) emit({ type: "text", data: text });
      }
    } catch {
      emit({ type: "text", data: line });
    }
  });
  signal.addEventListener("abort", () => child.kill(), { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (code !== 0)
      throw new Error(`Claude Code exited (${code}): ${stderr.slice(-2000)}`);
    if (!output) throw new Error("Claude Code returned no structured result");
    return { session, text: output };
  } finally {
    server.close();
  }
}
