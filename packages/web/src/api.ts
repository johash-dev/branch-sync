let sessionToken = "";

export async function api<T = any>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (method !== "GET" && !sessionToken)
    sessionToken = (await (await fetch("/api/session")).json()).token;
  const send = () =>
    fetch(`/api${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "GET" ? {} : { "x-sync-token": sessionToken }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let response = await send();
  if (response.status === 403 && method !== "GET") {
    sessionToken = (await (await fetch("/api/session")).json()).token;
    response = await send();
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data as T;
}

export const providerLabel = (provider: string) =>
  ({ codex: "Codex", cursor: "Cursor", claude: "Claude Code" })[provider] ||
  provider;

export const statusLabel = (status: string) =>
  ({
    open: "Needs assessment",
    planned: "Plan ready for review",
    approved: "Ready to implement",
    implementing: "Implementation in progress",
    review_required: "Ready for review",
    changes_requested: "Changes requested",
    verified_local: "Ready for handoff",
    resolved_no_action: "No target work",
    integrated: "Integrated",
    needs_investigation: "Needs investigation",
    missing: "Port needed",
    partial: "Partly present",
    present: "Already present",
    no_target_impact: "No target impact",
    intentional_divergence: "Intentional difference",
    superseded: "Superseded",
  })[status] || status.replaceAll("_", " ");

export const isTerminal = (status: string) =>
  ["done", "failed", "cancelled"].includes(status);
