import { describe, expect, it } from "vitest";
import { loadConfig, assertValid } from "../../src/env";
import { idempotencyKey, mintTicket, mintToolToken, stableStringify, verifyTicket, verifyToolToken } from "../../src/tokens";
import { buildCustomTools } from "../../src/tools/definitions";
import { canTransition } from "../../src/voice/session";
import { scrub, createLogger } from "../../src/logger";
import { validateAlebexSchema, ROLE_TOOLS } from "@guardian/shared";
import { makeReversePhrase } from "../../src/seed";

const SECRET = "x".repeat(40);

describe("environment validation", () => {
  it("defaults to mock mode with no credentials", () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe("mock");
    expect(cfg.errors).toEqual([]);
    expect(cfg.signingSecretEphemeral).toBe(true);
  });

  it("requires a token and an agent in live mode, with actionable messages", () => {
    const cfg = loadConfig({ ALEBEX_MODE: "live" });
    expect(cfg.errors.join(" ")).toMatch(/token/);
    expect(cfg.errors.join(" ")).toMatch(/ALEBEX_AGENT_DEFAULT_ID/);
    expect(() => assertValid(cfg)).toThrow(/Invalid configuration/);
  });

  it("accepts ALEBEX_VOICE_TOKEN and ALEB_API_KEY aliases, preferring ALEBEX_API_KEY", () => {
    expect(loadConfig({ ALEB_API_KEY: "a" }).tokenSource).toBe("ALEB_API_KEY");
    expect(loadConfig({ ALEBEX_VOICE_TOKEN: "b", ALEB_API_KEY: "a" }).tokenSource).toBe("ALEBEX_VOICE_TOKEN");
    expect(loadConfig({ ALEBEX_API_KEY: "c", ALEB_API_KEY: "a" }).alebexToken).toBe("c");
  });

  it("uses the default agent for every role and flags the single-agent fallback", () => {
    const cfg = loadConfig({ ALEBEX_MODE: "live", ALEBEX_API_KEY: "t", ALEBEX_AGENT_DEFAULT_ID: "d", ALEBEX_AGENT_SENTINEL_ID: "s" });
    expect(cfg.agents).toEqual({ trustline: "d", sentinel: "s", recovery: "d" });
    expect(cfg.singleAgentFallback).toBe(true);
    expect(cfg.warnings.join(" ")).toMatch(/Single-agent fallback/);
    expect(cfg.errors).toEqual([]);
  });

  it("enters voice-only live mode without a public tool URL", () => {
    const cfg = loadConfig({ ALEBEX_MODE: "live", ALEBEX_API_KEY: "t", ALEBEX_AGENT_DEFAULT_ID: "d" });
    expect(cfg.mode).toBe("live-voice-only");
    expect(cfg.warnings.join(" ")).toMatch(/voice-only/);
  });

  it("rejects non-https or loopback tool URLs", () => {
    expect(loadConfig({ PUBLIC_TOOL_BASE_URL: "http://example.com" }).publicToolBaseUrl).toBeNull();
    expect(loadConfig({ PUBLIC_TOOL_BASE_URL: "https://localhost" }).publicToolBaseUrl).toBeNull();
    expect(loadConfig({ PUBLIC_TOOL_BASE_URL: "https://abc.trycloudflare.com/" }).publicToolBaseUrl).toBe("https://abc.trycloudflare.com");
    const live = loadConfig({ ALEBEX_MODE: "live", ALEBEX_API_KEY: "t", ALEBEX_AGENT_DEFAULT_ID: "d", PUBLIC_TOOL_BASE_URL: "https://abc.trycloudflare.com" });
    expect(live.mode).toBe("live");
  });

  it("rejects an invalid mode", () => {
    expect(loadConfig({ ALEBEX_MODE: "prod" }).errors.join()).toMatch(/ALEBEX_MODE/);
  });
});

describe("short-lived tool tokens", () => {
  const now = Date.now();
  const exp = Math.floor(now / 1000) + 60;

  it("verifies a valid token and exposes its scope", () => {
    const t = mintToolToken(SECRET, { sid: "vs_1", role: "sentinel", tools: ["get_guardian_case"], exp });
    const v = verifyToolToken(SECRET, t, now);
    expect(v.ok && v.claims).toMatchObject({ sid: "vs_1", role: "sentinel", tools: ["get_guardian_case"] });
  });

  it("rejects expired, tampered, foreign-secret and wrong-type tokens", () => {
    const t = mintToolToken(SECRET, { sid: "vs_1", role: "sentinel", tools: [], exp });
    expect(verifyToolToken(SECRET, t, (exp + 1) * 1000)).toEqual({ ok: false, error: "expired" });
    const [p, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ typ: "tool", sid: "vs_1", role: "sentinel", tools: ["temporary_card_lock"], exp })).toString("base64url");
    expect(verifyToolToken(SECRET, `${forged}.${s}`, now)).toEqual({ ok: false, error: "bad_signature" });
    expect(verifyToolToken("y".repeat(40), t, now)).toEqual({ ok: false, error: "bad_signature" });
    expect(verifyToolToken(SECRET, `${p}`, now)).toEqual({ ok: false, error: "malformed" });
    const ticket = mintTicket(SECRET, { sid: "vs_1", exp, n: "abc" });
    expect(verifyToolToken(SECRET, ticket, now)).toEqual({ ok: false, error: "wrong_type" });
    expect(verifyTicket(SECRET, t, now)).toEqual({ ok: false, error: "wrong_type" });
    expect(verifyTicket(SECRET, ticket, now).ok).toBe(true);
  });
});

describe("idempotency keys", () => {
  it("are stable under key order and differ by call, tool and arguments", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    const k = idempotencyKey("call-1", "temporary_card_lock", { a: 1, b: 2 });
    expect(idempotencyKey("call-1", "temporary_card_lock", { b: 2, a: 1 })).toBe(k);
    expect(idempotencyKey("call-2", "temporary_card_lock", { a: 1, b: 2 })).not.toBe(k);
    expect(idempotencyKey("call-1", "flag_suspicious_transaction", { a: 1, b: 2 })).not.toBe(k);
    expect(idempotencyKey("call-1", "temporary_card_lock", { a: 1, b: 3 })).not.toBe(k);
  });
});

describe("customTools builder", () => {
  it("builds valid, least-privilege, per-session tools without secrets", () => {
    const tools = buildCustomTools({ role: "trustline", sessionId: "vs_abc", baseUrl: "https://x.example.com/", signingSecret: SECRET, ttlSec: 600 });
    expect(tools.map((t) => t.name)).toEqual([...ROLE_TOOLS.trustline]);
    for (const t of tools) {
      expect(t.url).toMatch(/^https:\/\/x\.example\.com\/tools\/[a-z_]+\?s=vs_abc$/);
      expect(t.headers?.["X-Guardian-Session"]).toBe("vs_abc");
      expect(t.headers?.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+$/);
      expect(JSON.stringify(t)).not.toContain(SECRET);
      expect(Object.keys(t.headers ?? {}).length).toBeLessThanOrEqual(10);
      expect(validateAlebexSchema(t.parameters)).toEqual([]);
      expect(t.timeoutMs).toBeLessThanOrEqual(15_000);
    }
  });
});

describe("voice session state machine", () => {
  it("allows the documented lifecycle and rejects invalid jumps", () => {
    const path = ["idle", "connecting_upstream", "starting", "active", "ending", "ended"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    expect(canTransition("idle", "active")).toBe(false);
    expect(canTransition("ended", "active")).toBe(false);
    expect(canTransition("active", "starting")).toBe(false);
    expect(canTransition("error", "active")).toBe(false);
    expect(canTransition("starting", "error")).toBe(true);
  });
});

describe("log redaction", () => {
  it("masks secret keys and token-shaped values", () => {
    const out = scrub({ authorization: "Bearer abc", nested: { apiKey: "k" }, msg: "token wt_abcdefghijklmnop leaked", ticket: "t" }) as Record<string, unknown>;
    expect(out.authorization).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).apiKey).toBe("[redacted]");
    expect(out.msg).toBe("token [redacted-token] leaked");
    expect(out.ticket).toBe("[redacted]");
    expect(scrub({ tokenConfigured: true })).toEqual({ tokenConfigured: true });
  });

  it("never writes a secret through the logger", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) });
    log.info("x", { token: "wt_supersecretvalue123", text: "my code is 123456" });
    expect(lines.join()).not.toContain("wt_supersecretvalue123");
    expect(lines.join()).not.toContain("123456");
  });
});

describe("reverse-auth phrases", () => {
  it("are two uppercase words", () => {
    expect(makeReversePhrase(() => 0)).toBe("BLUE MAPLE");
    for (let i = 0; i < 20; i++) expect(makeReversePhrase()).toMatch(/^[A-Z]+ [A-Z]+$/);
  });
});
