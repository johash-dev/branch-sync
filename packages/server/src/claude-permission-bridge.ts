import readline from "node:readline";

const endpoint = process.env.SYNC_PERMISSION_ENDPOINT;
const token = process.env.SYNC_PERMISSION_TOKEN;
if (!endpoint || !token) throw new Error("Permission bridge configuration missing");
const lines = readline.createInterface({ input: process.stdin });
function send(message: object) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
for await (const line of lines) {
  let message: any;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined) continue;
  try {
    let result: unknown;
    if (message.method === "initialize") {
      result = { protocolVersion: message.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "sync_permission", version: "0.1.0" } };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "approve", description: "Ask the Branch Sync Workbench developer to approve or deny a Claude Code tool request.", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] } }] };
    } else if (message.method === "tools/call" && message.params?.name === "approve") {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-sync-bridge-token": token }, body: JSON.stringify(message.params.arguments || {}) });
      if (!response.ok) throw new Error(`Permission bridge HTTP ${response.status}`);
      result = { content: [{ type: "text", text: JSON.stringify(await response.json()) }] };
    } else if (message.method === "ping") result = {};
    else { send({ id: message.id, error: { code: -32601, message: "Method not found" } }); continue; }
    send({ id: message.id, result });
  } catch (error) { send({ id: message.id, error: { code: -32000, message: String(error) } }); }
}
