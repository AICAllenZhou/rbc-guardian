import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ROLE_TOOLS, type CreateSessionResponse } from "@guardian/shared";
import { FRAME_BYTES } from "@guardian/alebex-protocol";
import { startMockAlebex, type MockAlebex } from "../../src/mock/mock-alebex";
import { SEED_CASE_ID } from "../../src/seed";
import { connect, openCall, post, sleep, startGateway, type TestGateway } from "./helpers";

let t: TestGateway | null = null;
let extraMock: MockAlebex | null = null;

afterEach(async () => {
  await t?.close();
  await extraMock?.close();
  t = null;
  extraMock = null;
});

describe("gateway ↔ mock Alebex handshake", () => {
  it("refuses a Sentinel call before detection", async () => {
    t = await startGateway();
    const r = await post(t.base, "/api/sessions", { role: "sentinel" });
    expect(r.status).toBe(409);
  });

  it("opens upstream with the token subprotocol, sends start_call once with the role's agent and tools", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const { client, session } = await openCall(t, "sentinel");
    await client.waitFor("state", (m) => m.state === "active");
    await client.nextHint(0);
    const call = t.gw.mock!.calls[0]!;
    expect(call.subprotocolOk).toBe(true);
    expect(call.startCalls).toBe(1);
    expect(call.agentId).toBe("mock-agent-sentinel");
    expect(call.toolNames).toEqual([...ROLE_TOOLS.sentinel]);
    expect(session.toolsEnabled).toBe(true);
    expect(JSON.stringify(session)).not.toMatch(/mock-runtime-token|signing/i);
    client.ws.close();
  });

  it("gives each role its own agent ID and least-privilege tools", async () => {
    t = await startGateway();
    const { client } = await openCall(t, "trustline");
    await client.nextHint(0);
    const call = t.gw.mock!.calls[0]!;
    expect(call.agentId).toBe("mock-agent-trustline");
    expect(call.toolNames).not.toContain("temporary_card_lock");
    client.ws.close();
  });
});

describe("audio and control forwarding", () => {
  it("forwards binary mic frames upstream unchanged", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const { client } = await openCall(t, "sentinel");
    await client.waitFor("state", (m) => m.state === "active");
    for (let i = 0; i < 5; i++) client.ws.send(Buffer.alloc(FRAME_BYTES, i), { binary: true });
    await sleep(150);
    const call = t.gw.mock!.calls[0]!;
    expect(call.audioBytesIn).toBe(5 * FRAME_BYTES);
    expect([...call.frameSizes]).toEqual([FRAME_BYTES]);
    client.ws.close();
  });

  it("drops malformed mic frames (odd length, oversized)", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const { client } = await openCall(t, "sentinel");
    await client.waitFor("state", (m) => m.state === "active");
    client.ws.send(Buffer.alloc(3), { binary: true });
    client.ws.send(Buffer.alloc(40_000), { binary: true });
    await sleep(100);
    expect(t.gw.mock!.calls[0]!.audioBytesIn).toBe(0);
    client.ws.close();
  });

  it("delivers agent audio as binary PCM and round-trips marks only after playback", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const { client } = await openCall(t, "sentinel", { autoAckMarks: false });
    const mark = await client.waitFor("mark");
    expect(client.binary.length).toBeGreaterThan(0);
    expect(client.binary.every((b) => b.byteLength % 2 === 0)).toBe(true);
    const call = t.gw.mock!.calls[0]!;
    expect(call.marksAcked).toEqual([]);
    client.ws.send(JSON.stringify({ type: "mark_played", mark: mark.mark }));
    // A forged or repeated mark is never forwarded.
    client.ws.send(JSON.stringify({ type: "mark_played", mark: mark.mark }));
    client.ws.send(JSON.stringify({ type: "mark_played", mark: { type: "mark", name: "forged" } }));
    await sleep(100);
    expect(call.marksAcked).toEqual([String(mark.mark.name)]);
    client.ws.close();
  });

  it("forwards user transcript partials as full snapshots and commits one message per utterance", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const { client } = await openCall(t, "sentinel");
    const h = await client.nextHint(0);
    client.say(h[0]!);
    await client.waitFor("message", (m) => m.role === "user");
    const partials = client.messages.filter((m) => m.type === "transcript" && m.role === "user").map((m) => (m as { text: string }).text);
    expect(partials.length).toBeGreaterThan(1);
    // Each partial restates the utterance so far (a snapshot), never a fragment to append.
    partials.forEach((p) => expect(h[0]!.startsWith(p)).toBe(true));
    const messages = client.messages.filter((m) => m.type === "message");
    expect(new Set(messages.map((m) => (m as { text: string }).text)).size).toBe(messages.length);
    client.ws.close();
  });

  it("finishes promptly on call_ended even though the engine leaves the socket open", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const { client } = await openCall(t, "sentinel");
    await client.waitFor("state", (m) => m.state === "active");
    const t0 = Date.now();
    client.ws.send(JSON.stringify({ type: "end" }));
    await client.waitFor("ended");
    expect(Date.now() - t0).toBeLessThan(250); // the 300 ms grace timer never had to fire
    expect(await client.waitClose()).toBe(1000);
  });

  it("forwards clear_audio on barge-in and never acknowledges the interrupted utterance", async () => {
    t = await startGateway({}, { mock: { pace: 1 } });
    await post(t.base, "/api/demo/detect");
    const { client } = await openCall(t, "sentinel", { autoAckMarks: false });
    await client.waitFor("state", (m) => m.state === "active");
    await sleep(250); // agent is mid-sentence
    client.say("Sorry, who is this?");
    await client.waitFor("clear_audio");
    const call = t.gw.mock!.calls[0]!;
    expect(call.marksSent).not.toContain("utt-1");
    client.ws.close();
  });
});

describe("end-to-end Sentinel workflow through Custom Tools", () => {
  it("verifies, protects once, raises risk and queues review", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const { client } = await openCall(t, "sentinel");
    const h1 = await client.nextHint(0);
    expect(h1[0]).toMatch(/matches/i);
    client.say(h1[0]!);
    const h2 = await client.nextHint(1);
    client.say(h2[0]!); // not me + code request
    const h3 = await client.nextHint(2);
    client.say(h3[0]!); // yes, lock
    await client.nextHint(3);

    const view = t.gw.cases.view(SEED_CASE_ID);
    expect(view.case.reverseAuth?.verified).toBe(true);
    expect(view.case.riskScore).toBe(99);
    expect(view.case.cardLocked).toBe(true);
    expect(view.case.transactionFlagged).toBe(true);
    expect(view.case.humanReview?.priority).toBe("urgent");
    expect(view.events.filter((e) => e.type === "card_locked")).toHaveLength(1);
    expect(view.events.filter((e) => e.type === "tool_replayed")).toHaveLength(1);
    expect(view.tools.filter((x) => x.tool === "temporary_card_lock").map((x) => x.status)).toEqual(["ok", "replayed"]);
    expect(view.messages.length).toBeGreaterThan(4);

    client.ws.send(JSON.stringify({ type: "end" }));
    await client.waitFor("ended");
    await client.waitClose();
    expect(t.gw.mock!.calls[0]!.endCallReceived).toBe(true);
    expect(t.gw.store.getSession(t.gw.store.listSessions(SEED_CASE_ID)[0]!.id)?.state).toBe("ended");
  });

  it("continues the case with the Recovery agent", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    await post(t.base, `/api/cases/${SEED_CASE_ID}/operator`, { tool: "temporary_card_lock", arguments: { customer_confirmed: true, reason: "operator" } });
    const { client, session } = await openCall(t, "recovery");
    expect(session.caseId).toBe(SEED_CASE_ID);
    await client.nextHint(0);
    const agentText = client.messages.filter((m) => m.type === "message" && m.role === "agent").map((m) => (m as { text: string }).text).join(" ");
    expect(agentText).toMatch(/Nora/);
    expect(agentText).toMatch(/temporarily locked/);
    client.ws.close();
  });

  it("TrustLine opens a new case from the customer's report", async () => {
    t = await startGateway();
    const { client, session } = await openCall(t, "trustline");
    expect(session.caseId).toMatch(/^GUARD-\d{4}$/);
    expect(session.caseId).not.toBe(SEED_CASE_ID);
    const h1 = await client.nextHint(0);
    client.say(h1[0]!);
    const h2 = await client.nextHint(1);
    client.say(h2[0]!);
    await client.nextHint(2);
    const c = t.gw.cases.view(session.caseId).case;
    expect(c.status).toBe("review_requested");
    expect(c.channel).toBe("phone_call");
    expect(c.riskScore).toBeGreaterThanOrEqual(65);
    client.ws.close();
  });
});

describe("session security", () => {
  it("rejects a bad ticket and a reused ticket", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const res = await post<CreateSessionResponse>(t.base, "/api/sessions", { role: "sentinel" });
    const bad = await connect(t, res.body.wsPath, "not-a-ticket");
    expect(await bad.waitClose()).toBe(4401);
    const good = await connect(t, res.body.wsPath, res.body.ticket);
    await good.waitFor("state", (m) => m.state === "active");
    const reuse = await connect(t, res.body.wsPath, res.body.ticket);
    expect(await reuse.waitClose()).toBe(4401);
    good.ws.close();
  });

  it("rejects a foreign Origin", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const res = await post<CreateSessionResponse>(t.base, "/api/sessions", { role: "sentinel" });
    const ws = new WebSocket(`${t.wsBase}${res.body.wsPath}`, [`guardian.ticket.${res.body.ticket}`], { origin: "https://evil.example" });
    const err = await new Promise<string>((resolve) => ws.on("error", (e) => resolve(e.message)));
    expect(err).toMatch(/403/);
  });
});

describe("upstream failures", () => {
  async function liveAgainstMock(token: string, agent = "agent-x") {
    extraMock = await startMockAlebex({ pace: 0 });
    t = await startGateway({ ALEBEX_MODE: "live", ALEBEX_API_KEY: token, ALEBEX_AGENT_DEFAULT_ID: agent, ALEBEX_WS_URL: extraMock.url }, { limits: { backoffBaseMs: 10 } });
    await post(t.base, "/api/demo/detect");
    return openCall(t, "sentinel");
  }

  it("voice-only live mode sends no customTools", async () => {
    const { client, session } = await liveAgainstMock("tok");
    expect(session.mode).toBe("live-voice-only");
    expect(session.toolsEnabled).toBe(false);
    await client.waitFor("state", (m) => m.state === "active");
    await sleep(50);
    expect(extraMock!.calls[0]!.toolNames).toEqual([]);
    client.ws.close();
  });

  it("maps an upgrade 403 to upstream_auth and closes 4403", async () => {
    const { client } = await liveAgainstMock("invalid");
    const e = await client.waitFor("error");
    expect(e.code).toBe("upstream_auth");
    expect(e.recoverable).toBe(false);
    expect(await client.waitClose()).toBe(4403);
  });

  it("retries capacity refusals with backoff, then reports them", async () => {
    const { client } = await liveAgainstMock("at-capacity");
    const e = await client.waitFor("error");
    expect(e.code).toBe("upstream_capacity");
    expect(client.messages.filter((m) => m.type === "state" && m.state === "connecting_upstream" && m.detail).length).toBe(2);
    expect(await client.waitClose()).toBe(4429);
  });

  it("propagates the live engine's unknown-agent refusal (payload_unavailable + 1011) as a config error", async () => {
    const { client } = await liveAgainstMock("tok", "missing-agent");
    const e = await client.waitFor("error", (m) => m.code === "payload_unavailable");
    expect(e.message).toMatch(/could not load this agent/);
    expect(e.recoverable).toBe(false);
    expect(await client.waitClose()).toBe(4422);
    expect(client.messages.some((m) => m.type === "error" && m.code === "upstream_lost")).toBe(false);
  });

  it("maps a documented invalid_config refusal (1008) to a config error", async () => {
    t = await startGateway();
    t.cfg.gatewayOrigin = "http://public.example.com"; // tool URLs must be https on a public host
    await post(t.base, "/api/demo/detect");
    const { client } = await openCall(t, "sentinel");
    const e = await client.waitFor("error", (m) => m.code === "invalid_config");
    expect(e.recoverable).toBe(false);
    expect(await client.waitClose()).toBe(4422);
  });

  it("reports a dropped upstream socket as recoverable", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const { client } = await openCall(t, "sentinel");
    await client.waitFor("state", (m) => m.state === "active");
    await t.gw.mock!.close();
    const e = await client.waitFor("error", (m) => m.code === "upstream_lost");
    expect(e.recoverable).toBe(true);
    expect(await client.waitClose()).toBe(4502);
  });

  it("sends end_call upstream when the browser disappears", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const { client } = await openCall(t, "sentinel");
    await client.waitFor("state", (m) => m.state === "active");
    client.ws.terminate();
    await sleep(200);
    expect(t.gw.mock!.calls[0]!.endCallReceived).toBe(true);
    expect(t.gw.sessions.activeCount).toBe(0);
  });
});

describe("SSE case timeline", () => {
  it("streams case events as they happen", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const ctl = new AbortController();
    const res = await fetch(`${t.base}/api/events?caseId=${SEED_CASE_ID}`, { signal: ctl.signal, headers: { Origin: "http://localhost:3000" } });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const reader = res.body!.getReader();
    await post(t.base, `/api/cases/${SEED_CASE_ID}/operator`, { tool: "request_human_review", arguments: { priority: "standard", summary: "x" } });
    let text = "";
    const dec = new TextDecoder();
    for (let i = 0; i < 10 && !text.includes("human_review_requested"); i++) {
      const { value } = await reader.read();
      text += dec.decode(value);
    }
    expect(text).toContain("event: event");
    expect(text).toContain("human_review_requested");
    ctl.abort();
  });

  it("exports a JSON case summary and exposes safe readiness only", async () => {
    t = await startGateway();
    await post(t.base, "/api/demo/detect");
    const sum = await fetch(`${t.base}/api/cases/${SEED_CASE_ID}/summary`);
    expect(sum.headers.get("content-disposition")).toMatch(/GUARD-4821-summary\.json/);
    const body = (await sum.json()) as { disclaimer: string };
    expect(body.disclaimer).toMatch(/Not an official RBC product/);
    const ready = await (await fetch(`${t.base}/api/readiness`)).text();
    expect(ready).toMatch(/"mode":"mock"/);
    expect(ready).not.toMatch(/tttttttt/);
  });
});
