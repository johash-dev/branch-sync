function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text.trim()) };
  } catch {
    return { ok: false };
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function topLevelObjects(text: string): string[] {
  const found: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return found;
}

export function agentReplyExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "(empty)";
  return compact.length > 80 ? `${compact.slice(0, 80)}...` : compact;
}

export function extractAgentJson(text: string): unknown {
  const trimmed = text.trim();
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = tryParse(fences[i][1]);
    if (parsed.ok && isJsonObject(parsed.value)) return parsed.value;
  }
  const whole = tryParse(trimmed);
  if (whole.ok && isJsonObject(whole.value)) return whole.value;
  const objects = topLevelObjects(trimmed);
  for (let i = objects.length - 1; i >= 0; i--) {
    const parsed = tryParse(objects[i]);
    if (parsed.ok && isJsonObject(parsed.value)) return parsed.value;
  }
  throw new Error(`Agent reply was not JSON: ${agentReplyExcerpt(trimmed)}`);
}

export function hasAgentJson(text: string): boolean {
  try {
    extractAgentJson(text);
    return true;
  } catch {
    return false;
  }
}
