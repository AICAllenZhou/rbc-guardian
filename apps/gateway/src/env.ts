/**
 * Environment validation. Secrets are read here and nowhere else; the resulting
 * config object is never serialised to clients (see `readiness()`).
 */
import { randomBytes } from "node:crypto";
import type { AgentRole, RuntimeMode } from "@guardian/shared";
import { ALEBEX_WS_URL } from "@guardian/alebex-protocol";

export interface GatewayConfig {
  requestedMode: "mock" | "live";
  mode: RuntimeMode;
  port: number;
  host: string;
  appOrigin: string;
  gatewayOrigin: string;
  databasePath: string;
  alebexToken: string | null;
  tokenSource: string | null;
  upstreamUrl: string;
  agents: Record<AgentRole, string | null>;
  singleAgentFallback: boolean;
  publicToolBaseUrl: string | null;
  signingSecret: string;
  signingSecretEphemeral: boolean;
  maxSessionSec: number;
  warnings: string[];
  errors: string[];
}

export class ConfigError extends Error {}

const ROLES: AgentRole[] = ["trustline", "sentinel", "recovery"];
const ROLE_ENV: Record<AgentRole, string> = {
  trustline: "ALEBEX_AGENT_TRUSTLINE_ID",
  sentinel: "ALEBEX_AGENT_SENTINEL_ID",
  recovery: "ALEBEX_AGENT_RECOVERY_ID",
};

/** Token variable names, in priority order. `ALEB_API_KEY` is what this project's original .env uses. */
export const TOKEN_ENV_NAMES = ["ALEBEX_API_KEY", "ALEBEX_VOICE_TOKEN", "ALEB_API_KEY"] as const;

function clean(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

export function resolveToken(env: NodeJS.ProcessEnv): { token: string | null; source: string | null } {
  for (const name of TOKEN_ENV_NAMES) {
    const v = clean(env[name]);
    if (v) return { token: v, source: name };
  }
  return { token: null, source: null };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const warnings: string[] = [];
  const errors: string[] = [];

  const rawMode = (clean(env.ALEBEX_MODE) ?? "mock").toLowerCase();
  if (rawMode !== "mock" && rawMode !== "live") errors.push(`ALEBEX_MODE must be "mock" or "live" (got "${rawMode}")`);
  const requestedMode = rawMode === "live" ? "live" : "mock";

  const { token, source } = resolveToken(env);
  const fallback = clean(env.ALEBEX_AGENT_DEFAULT_ID);
  const agents = Object.fromEntries(ROLES.map((r) => [r, clean(env[ROLE_ENV[r]]) ?? fallback])) as Record<AgentRole, string | null>;
  const singleAgentFallback = !!fallback && ROLES.some((r) => !clean(env[ROLE_ENV[r]]));

  let publicToolBaseUrl = clean(env.PUBLIC_TOOL_BASE_URL);
  if (publicToolBaseUrl) {
    try {
      const u = new URL(publicToolBaseUrl);
      if (u.protocol !== "https:") throw new Error("not https");
      if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(u.hostname)) throw new Error("loopback");
      publicToolBaseUrl = u.origin + u.pathname.replace(/\/+$/, "");
    } catch {
      warnings.push("PUBLIC_TOOL_BASE_URL must be a public https:// URL; ignoring it. Alebex refuses http, loopback and private hosts.");
      publicToolBaseUrl = null;
    }
  }

  let signingSecret = clean(env.TOOL_SIGNING_SECRET);
  let signingSecretEphemeral = false;
  if (!signingSecret || signingSecret.length < 32) {
    if (signingSecret) warnings.push("TOOL_SIGNING_SECRET is shorter than 32 characters; using a random per-process secret instead.");
    signingSecret = randomBytes(32).toString("base64url");
    signingSecretEphemeral = true;
  }

  let mode: RuntimeMode = "mock";
  if (requestedMode === "live") {
    if (!token) errors.push(`ALEBEX_MODE=live needs an Alebex token in ${TOKEN_ENV_NAMES.join(" or ")}. Get it from the Alebex developer console.`);
    const missing = ROLES.filter((r) => !agents[r]);
    if (missing.length === ROLES.length) {
      errors.push("ALEBEX_MODE=live needs at least ALEBEX_AGENT_DEFAULT_ID or one ALEBEX_AGENT_<ROLE>_ID. Copy agent IDs from app.alebex.ai/dev → Voice Agents.");
    } else if (missing.length > 0) {
      warnings.push(`No agent ID for: ${missing.join(", ")}. Those calls are disabled until configured.`);
    }
    if (singleAgentFallback) warnings.push("Single-agent fallback: ALEBEX_AGENT_DEFAULT_ID is used for roles without their own agent. All personas will share one prompt and voice.");
    mode = publicToolBaseUrl ? "live" : "live-voice-only";
    if (!publicToolBaseUrl) {
      warnings.push("Live voice-only mode: PUBLIC_TOOL_BASE_URL is not set, so Custom Tools are disabled. Case updates come from operator actions only. Run `pnpm tunnel` to get a public HTTPS URL.");
    }
    if (signingSecretEphemeral && publicToolBaseUrl) warnings.push("TOOL_SIGNING_SECRET not set; tool tokens use a random per-process secret and stop verifying after a restart.");
  }

  const port = Number(clean(env.GATEWAY_PORT) ?? clean(env.PORT) ?? "3001");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) errors.push("GATEWAY_PORT must be a valid port");

  const dbUrl = clean(env.DATABASE_URL) ?? "file:./data/guardian.db";
  const databasePath = dbUrl === ":memory:" ? ":memory:" : dbUrl.replace(/^file:/, "");

  const cfg: GatewayConfig = {
    requestedMode,
    mode,
    port,
    host: clean(env.GATEWAY_HOST) ?? "127.0.0.1",
    appOrigin: clean(env.APP_ORIGIN) ?? "http://localhost:3000",
    gatewayOrigin: clean(env.GATEWAY_ORIGIN) ?? `http://localhost:${port}`,
    databasePath,
    alebexToken: token,
    tokenSource: source,
    upstreamUrl: clean(env.ALEBEX_WS_URL) ?? ALEBEX_WS_URL,
    agents,
    singleAgentFallback,
    publicToolBaseUrl,
    signingSecret,
    signingSecretEphemeral,
    maxSessionSec: Number(clean(env.MAX_SESSION_SEC) ?? "600"),
    warnings,
    errors,
  };
  return cfg;
}

export function assertValid(cfg: GatewayConfig): void {
  if (cfg.errors.length) throw new ConfigError(`Invalid configuration:\n  - ${cfg.errors.join("\n  - ")}`);
}
