import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../src/store";
import { EventBus } from "../../src/events";
import { CaseService } from "../../src/cases";
import { ToolService } from "../../src/tools/handlers";
import { createLogger } from "../../src/logger";
import { mintToolToken } from "../../src/tokens";
import { SEED_CASE_ID } from "../../src/seed";

const SECRET = "s".repeat(40);

function setup() {
  const store = new Store(":memory:");
  const bus = new EventBus();
  const cases = new CaseService(store, bus, () => 0);
  cases.resetDemo();
  cases.detect();
  const tools = new ToolService(store, cases, SECRET, createLogger({ silent: true }));
  store.putSession({ id: "vs_1", role: "sentinel", caseId: SEED_CASE_ID, mode: "mock", state: "active", toolsEnabled: true, startedAt: new Date(Date.now() - 1000).toISOString(), endedAt: null, endReason: null });
  const ctx = { role: "sentinel" as const, sessionId: "vs_1", caseId: SEED_CASE_ID, callId: "call-1" };
  return { store, cases, tools, ctx, bus };
}

function headers(role: "sentinel" | "trustline" = "sentinel", tools: string[] = ["temporary_card_lock", "get_guardian_case"], sid = "vs_1") {
  const token = mintToolToken(SECRET, { sid, role, tools, exp: Math.floor(Date.now() / 1000) + 60 });
  return { authorization: `Bearer ${token}`, "x-guardian-session": sid };
}

const envelope = (tool: string, args: Record<string, unknown> = {}) => ({ tool, arguments: args, call: { id: "public-call-1", agentId: "a" } });

describe("tool execution", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("applies a card lock exactly once when the model calls it twice", async () => {
    const args = { customer_confirmed: true, reason: "denied purchase" };
    const first = await s.tools.run("temporary_card_lock", args, s.ctx);
    const second = await s.tools.run("temporary_card_lock", { ...args, reason: "rephrased reason" }, s.ctx);
    expect(first.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    const events = s.store.listEvents(SEED_CASE_ID);
    expect(events.filter((e) => e.type === "card_locked")).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool_replayed")).toHaveLength(1);
    expect(s.store.getCase(SEED_CASE_ID)?.cardLocked).toBe(true);
  });

  it("refuses a lock without explicit consent and does not pin that refusal", async () => {
    const r = await s.tools.run("temporary_card_lock", { customer_confirmed: false, reason: "x" }, s.ctx);
    expect(r.status).toBe(409);
    expect(s.store.getCase(SEED_CASE_ID)?.cardLocked).toBe(false);
    const ok = await s.tools.run("temporary_card_lock", { customer_confirmed: true, reason: "x" }, s.ctx);
    expect(ok.status).toBe(200);
  });

  it("moves the seeded risk from 92 to 99 on denial plus an OTP request", async () => {
    expect(s.store.getCase(SEED_CASE_ID)?.riskScore).toBe(92);
    await s.tools.run("record_customer_response", { response_type: "denies_transaction" }, s.ctx);
    expect(s.store.getCase(SEED_CASE_ID)?.riskScore).toBe(96);
    await s.tools.run("record_customer_response", { response_type: "was_asked_for_code", note: "they asked for 482913" }, s.ctx);
    const c = s.store.getCase(SEED_CASE_ID)!;
    expect(c.riskScore).toBe(99);
    expect(c.riskHistory.map((h) => h.score)).toEqual([92, 96, 99]);
    expect(JSON.stringify(c)).not.toContain("482913");
  });

  it("issues one reverse-auth phrase per session and verifies it", async () => {
    const a = await s.tools.run("issue_reverse_auth_phrase", {}, s.ctx);
    const b = await s.tools.run("issue_reverse_auth_phrase", {}, { ...s.ctx, callId: "call-other" });
    expect(a.body.phrase).toBe("BLUE MAPLE");
    expect(b.body.phrase).toBe("BLUE MAPLE");
    await s.tools.run("record_customer_response", { response_type: "confirmed_reverse_auth" }, s.ctx);
    expect(s.store.getCase(SEED_CASE_ID)?.reverseAuth?.verified).toBe(true);
  });

  it("returns concise, human-readable results under 2 KB with demo wording", async () => {
    for (const [tool, args] of [
      ["get_guardian_case", {}],
      ["get_recent_transactions", { limit: 10 }],
      ["flag_suspicious_transaction", { reason: "denied" }],
      ["request_human_review", { priority: "urgent", summary: "x" }],
    ] as const) {
      const r = await s.tools.run(tool, args, s.ctx);
      expect(r.status, tool).toBe(200);
      expect(Buffer.byteLength(JSON.stringify(r.body))).toBeLessThan(2048);
      expect(JSON.stringify(r.body)).toMatch(/Sandbox demo|Demo only/);
    }
  });

  it("rejects invalid arguments with a readable error", async () => {
    const r = await s.tools.run("request_human_review", { priority: "asap" }, s.ctx);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/Invalid arguments/);
  });

  it("rejects flagging a transaction that is not on the case", async () => {
    const r = await s.tools.run("flag_suspicious_transaction", { transaction_id: "TXN-5K1P", reason: "x" }, s.ctx);
    expect(r.status).toBe(404);
  });
});

describe("tool HTTP authorisation", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("accepts a correctly scoped request", async () => {
    const r = await s.tools.handleHttp("get_guardian_case", headers(), { s: "vs_1" }, envelope("get_guardian_case"));
    expect(r.status).toBe(200);
    expect(r.body.caseId).toBe(SEED_CASE_ID);
  });

  it("rejects missing or bad credentials", async () => {
    expect((await s.tools.handleHttp("get_guardian_case", {}, {}, envelope("get_guardian_case"))).status).toBe(401);
    expect((await s.tools.handleHttp("get_guardian_case", { authorization: "Bearer nope", "x-guardian-session": "vs_1" }, {}, envelope("get_guardian_case"))).status).toBe(401);
  });

  it("rejects a session mismatch between token, header and URL", async () => {
    const h = headers();
    expect((await s.tools.handleHttp("get_guardian_case", { ...h, "x-guardian-session": "vs_2" }, {}, envelope("get_guardian_case"))).status).toBe(401);
    expect((await s.tools.handleHttp("get_guardian_case", h, { s: "vs_2" }, envelope("get_guardian_case"))).status).toBe(401);
  });

  it("enforces the role allowlist even if a token lists extra tools", async () => {
    s.store.putSession({ ...s.store.getSession("vs_1")!, role: "trustline" });
    const r = await s.tools.handleHttp("temporary_card_lock", headers("trustline", ["temporary_card_lock"]), {}, envelope("temporary_card_lock", { customer_confirmed: true, reason: "x" }));
    expect(r.status).toBe(403);
    expect(s.store.getCase(SEED_CASE_ID)?.cardLocked).toBe(false);
  });

  it("rejects a tool the token does not list", async () => {
    const r = await s.tools.handleHttp("flag_suspicious_transaction", headers("sentinel", ["get_guardian_case"]), {}, envelope("flag_suspicious_transaction", { reason: "x" }));
    expect(r.status).toBe(403);
  });

  it("refuses side effects once the call has ended", async () => {
    s.store.putSession({ ...s.store.getSession("vs_1")!, state: "ended" });
    const r = await s.tools.handleHttp("temporary_card_lock", headers(), {}, envelope("temporary_card_lock", { customer_confirmed: true, reason: "x" }));
    expect(r.status).toBe(409);
  });

  it("rejects malformed envelopes and envelope/path mismatch", async () => {
    expect((await s.tools.handleHttp("get_guardian_case", headers(), {}, { nope: true })).status).toBe(400);
    expect((await s.tools.handleHttp("get_guardian_case", headers(), {}, envelope("temporary_card_lock"))).status).toBe(400);
    expect((await s.tools.handleHttp("drop_tables", headers(), {}, envelope("drop_tables"))).status).toBe(404);
  });

  it("dedupes on the Alebex call.id carried in the envelope", async () => {
    const body = envelope("temporary_card_lock", { customer_confirmed: true, reason: "x" });
    await s.tools.handleHttp("temporary_card_lock", headers(), {}, body);
    const again = await s.tools.handleHttp("temporary_card_lock", headers(), {}, body);
    expect(again.body.replayed).toBe(true);
    expect(s.store.listToolInvocations(SEED_CASE_ID).map((t) => t.status)).toEqual(["ok", "replayed"]);
  });
});
