/**
 * Short-lived HMAC credentials.
 *  - Tool tokens ride in the Custom Tool `Authorization` header. Alebex holds them
 *    for the life of one call; they are scoped to one session, one role and that
 *    role's tool allowlist, and expire shortly after the session's max duration.
 *  - Browser tickets authorise one WebSocket upgrade for one session.
 * The permanent signing secret never leaves the gateway.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AgentRoleSchema } from "@guardian/shared";

const ToolClaimsSchema = z.object({
  typ: z.literal("tool"),
  sid: z.string(),
  role: AgentRoleSchema,
  tools: z.array(z.string()),
  exp: z.number(),
});
export type ToolClaims = z.infer<typeof ToolClaimsSchema>;

const TicketClaimsSchema = z.object({ typ: z.literal("ticket"), sid: z.string(), exp: z.number(), n: z.string() });
export type TicketClaims = z.infer<typeof TicketClaimsSchema>;

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function encode(secret: string, claims: object): string {
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${sign(secret, payload)}`;
}

export type VerifyError = "malformed" | "bad_signature" | "expired" | "wrong_type";

function decode(secret: string, token: string, now: number): { ok: true; claims: unknown } | { ok: false; error: VerifyError } {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: "malformed" };
  const expected = Buffer.from(sign(secret, parts[0]));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, error: "bad_signature" };
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "malformed" };
  }
  const exp = (claims as { exp?: unknown })?.exp;
  if (typeof exp !== "number" || exp * 1000 <= now) return { ok: false, error: "expired" };
  return { ok: true, claims };
}

export function mintToolToken(secret: string, claims: Omit<ToolClaims, "typ">): string {
  return encode(secret, { typ: "tool", ...claims });
}

export function verifyToolToken(secret: string, token: string, now = Date.now()): { ok: true; claims: ToolClaims } | { ok: false; error: VerifyError } {
  const d = decode(secret, token, now);
  if (!d.ok) return d;
  const parsed = ToolClaimsSchema.safeParse(d.claims);
  return parsed.success ? { ok: true, claims: parsed.data } : { ok: false, error: "wrong_type" };
}

export function mintTicket(secret: string, claims: Omit<TicketClaims, "typ">): string {
  return encode(secret, { typ: "ticket", ...claims });
}

export function verifyTicket(secret: string, token: string, now = Date.now()): { ok: true; claims: TicketClaims } | { ok: false; error: VerifyError } {
  const d = decode(secret, token, now);
  if (!d.ok) return d;
  const parsed = TicketClaimsSchema.safeParse(d.claims);
  return parsed.success ? { ok: true, claims: parsed.data } : { ok: false, error: "wrong_type" };
}

/** Stable JSON: sorted keys, so semantically equal arguments produce the same idempotency key. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function idempotencyKey(callId: string, tool: string, normalisedArgs: unknown): string {
  return createHmac("sha256", "guardian-idem").update(`${callId}\n${tool}\n${stableStringify(normalisedArgs)}`).digest("hex");
}
