import readline from "node:readline/promises";

const base = `http://127.0.0.1:${process.env.SYNC_PORT || 4317}/api`;
const [command, ...args] = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
let token = "";
async function request(
  route: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(method !== "GET" ? { "x-sync-token": token } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText);
  return value;
}
async function waitJob(id: string) {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let seen = 0;
  const answered = new Set<string>();
  let completed = false;
  let result: unknown;
  const printEvent = (event: any) => {
    if (event.type === "text") process.stdout.write(String(event.data));
    else if (["started", "failed", "done", "interrupted"].includes(event.type))
      console.error(event.type, event.data?.error || "");
  };
  const handleState = async (job: any) => {
    for (const interaction of job.interactions || []) {
      if (answered.has(interaction.id)) continue;
      answered.add(interaction.id);
      const raw = await terminal.question(
        `${interaction.type}\n${JSON.stringify(interaction.params, null, 2)}\nResponse (JSON or text): `,
      );
      let answer: unknown = raw;
      try {
        answer = JSON.parse(raw);
      } catch {}
      await request(`/jobs/${id}/interactions/${interaction.id}`, "POST", {
        value: answer,
      });
    }
    if (job.status === "done") {
      result = job.result;
      completed = true;
    }
    if (job.status === "failed" || job.status === "cancelled")
      throw new Error(job.error || job.status);
  };
  try {
    while (!completed) {
      const response = await fetch(`${base}/jobs/${id}/events`);
      if (!response.ok || !response.body)
        throw new Error(`Job event stream unavailable (${response.status})`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";
      let eventData = "";
      const processLine = async (line: string) => {
        if (line.startsWith("event: ")) eventType = line.slice(7);
        else if (line.startsWith("data: ")) eventData += line.slice(6);
        else if (line === "" && eventData) {
          const value = JSON.parse(eventData);
          if (eventType === "snapshot") {
            for (const event of value.events.slice(seen)) printEvent(event);
            seen = value.events.length;
            await handleState(value);
          } else if (eventType === "update") {
            if (value.seq > seen) {
              printEvent(value.event);
              seen = value.seq;
            }
            await handleState(value.state);
          }
          eventType = "";
          eventData = "";
        }
      };
      try {
        while (!completed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            await processLine(buffer.slice(0, newline).replace(/\r$/, ""));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!completed) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return result;
  } finally {
    terminal.close();
  }
}
async function main() {
  try {
    token = (await request("/session")).token;
  } catch {
    throw new Error(
      `Start the workbench first with npm start (${base} unavailable)`,
    );
  }
  const pair = option("pair"),
    gap = option("gap");
  const requirePair = () => {
    if (!pair) throw new Error("--pair is required");
    return pair;
  };
  const requireGap = () => {
    if (!gap) throw new Error("--gap is required");
    return gap;
  };
  switch (command) {
    case "workspace-health":
      return request("/health");
    case "sync-status":
      return pair
        ? request(`/pairs/${requirePair()}/snapshot`)
        : request("/health");
    case "find-gaps":
      return waitJob(
        (
          await request(`/pairs/${requirePair()}/analyze`, "POST", {
            offline: args.includes("--offline"),
          })
        ).jobId,
      );
    case "plan-gap":
      return waitJob(
        (
          await request(
            `/pairs/${requirePair()}/gaps/${requireGap()}/generate-plan`,
            "POST",
          )
        ).jobId,
      );
    case "approve-sync": {
      const by = option("by")?.trim();
      if (!by)
        throw new Error(
          "Pass --by with your name. Approval records who reviewed the plan, so a blank or default name is not accepted.",
        );
      return request(
        `/pairs/${requirePair()}/gaps/${requireGap()}/approve`,
        "POST",
        { approvedBy: by },
      );
    }
    case "implement-gap":
      return waitJob(
        (
          await request(
            `/pairs/${requirePair()}/gaps/${requireGap()}/implement`,
            "POST",
          )
        ).jobId,
      );
    case "review-sync":
      return waitJob(
        (
          await request(
            `/pairs/${requirePair()}/gaps/${requireGap()}/review`,
            "POST",
          )
        ).jobId,
      );
    case "record-sync":
      return waitJob(
        (
          await request(
            `/pairs/${requirePair()}/gaps/${requireGap()}/integrate`,
            "POST",
            {
              integratedSha: option("integrated-sha"),
              evidence: [
                option("evidence") ||
                  "Developer verified current target behavior",
              ],
            },
          )
        ).jobId,
      );
    default:
      throw new Error(
        "Commands: workspace-health, find-gaps, plan-gap, approve-sync, implement-gap, review-sync, record-sync, sync-status",
      );
  }
}
try {
  console.log(JSON.stringify(await main(), null, 2));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
