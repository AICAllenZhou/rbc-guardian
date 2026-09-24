import type { CustomToolDefinition } from "@guardian/alebex-protocol";
import { MAX_TOOLS_PER_CALL, ROLE_TOOLS, TOOL_SPECS, type AgentRole } from "@guardian/shared";
import { mintToolToken } from "../tokens";

export const TOOL_TIMEOUT_MS = 8_000;

/**
 * Build the `customTools` array for one session, server-side. Each tool carries a
 * short-lived token scoped to this session + role + allowlist, never the signing
 * secret or the Alebex key.
 */
export function buildCustomTools(opts: {
  role: AgentRole;
  sessionId: string;
  baseUrl: string;
  signingSecret: string;
  ttlSec: number;
  now?: number;
}): CustomToolDefinition[] {
  const tools = ROLE_TOOLS[opts.role];
  if (tools.length > MAX_TOOLS_PER_CALL) throw new Error(`role ${opts.role} exceeds ${MAX_TOOLS_PER_CALL} tools`);
  const exp = Math.floor((opts.now ?? Date.now()) / 1000) + opts.ttlSec;
  const token = mintToolToken(opts.signingSecret, { sid: opts.sessionId, role: opts.role, tools: [...tools], exp });
  const base = opts.baseUrl.replace(/\/+$/, "");
  return tools.map((name) => {
    const spec = TOOL_SPECS[name];
    return {
      name,
      description: spec.description,
      url: `${base}/tools/${name}?s=${encodeURIComponent(opts.sessionId)}`,
      headers: { Authorization: `Bearer ${token}`, "X-Guardian-Session": opts.sessionId },
      timeoutMs: TOOL_TIMEOUT_MS,
      parameters: spec.parameters,
    };
  });
}
