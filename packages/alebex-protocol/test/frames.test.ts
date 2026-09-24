import { describe, expect, it } from "vitest";
import { alebexSubprotocol, buildStartCall, describeShape, parseServerText } from "../src/frames";

describe("client frames", () => {
  it("builds the documented start_call shape and omits empty customTools", () => {
    expect(buildStartCall("agent-1", [])).toEqual({ type: "start_call", agent: { id: "agent-1" } });
    const tool = { name: "x", description: "d", url: "https://e.x/t", parameters: { type: "object", properties: {} } };
    expect(buildStartCall("agent-1", [tool]).customTools).toEqual([tool]);
  });

  it("uses the alebex.token. subprotocol", () => {
    expect(alebexSubprotocol("abc")).toBe("alebex.token.abc");
  });
});

describe("parseServerText (shapes confirmed by the live probe)", () => {
  const b64 = Buffer.from([1, 0, 2, 0]).toString("base64");

  it("decodes live audio frames {data, format: pcm16, sample_rate}", () => {
    const e = parseServerText(JSON.stringify({ type: "audio", data: b64, format: "pcm16", sample_rate: 24000 }));
    expect(e).toMatchObject({ kind: "audio", sampleRate: 24000 });
    if (e.kind === "audio") expect(Array.from(e.pcm)).toEqual([1, 0, 2, 0]);
  });

  it("carries a non-default sample rate through instead of assuming 24 kHz", () => {
    expect(parseServerText(JSON.stringify({ type: "audio", data: b64, format: "pcm16", sample_rate: 16000 }))).toMatchObject({ kind: "audio", sampleRate: 16000 });
  });

  it("refuses unconfirmed audio layouts and formats rather than guessing", () => {
    expect(parseServerText(JSON.stringify({ type: "audio", payload: b64 })).kind).toBe("unknown");
    expect(parseServerText(JSON.stringify({ type: "audio", data: b64, format: "mulaw" }))).toMatchObject({ kind: "unknown", reason: expect.stringContaining("mulaw") });
    expect(parseServerText(JSON.stringify({ type: "audio", data: "@@@" })).kind).toBe("unknown");
  });

  it("keeps mark frames verbatim for echo", () => {
    expect(parseServerText(JSON.stringify({ type: "mark", name: "m-1" }))).toEqual({ kind: "mark", raw: { type: "mark", name: "m-1" }, label: "m-1" });
    expect(parseServerText(JSON.stringify({ type: "mark", id: 3 })).kind).toBe("unknown");
  });

  it("reads user transcript snapshots with is_final", () => {
    expect(parseServerText(JSON.stringify({ type: "transcript", role: "user", text: "I received", is_final: false }))).toMatchObject({ kind: "transcript", role: "user", text: "I received", final: false });
    expect(parseServerText(JSON.stringify({ type: "transcript", role: "user", text: "Done", is_final: true }))).toMatchObject({ final: true });
  });

  it("reads conversation_message with assistant/user roles and content", () => {
    expect(parseServerText(JSON.stringify({ type: "conversation_message", role: "assistant", content: "Hi", timestamp: "2026-09-24T00:00:00Z" }))).toMatchObject({ kind: "conversation_message", role: "agent", text: "Hi" });
    expect(parseServerText(JSON.stringify({ type: "conversation_message", role: "user", content: "Yo" }))).toMatchObject({ role: "user" });
    expect(parseServerText(JSON.stringify({ type: "conversation_message", role: "robot", content: "?" })).kind).toBe("unknown");
  });

  it("parses the live error frame and the documented one", () => {
    expect(parseServerText(JSON.stringify({ type: "error", code: "payload_unavailable", message: "x" }))).toEqual({ kind: "error", code: "payload_unavailable", message: "x" });
    expect(parseServerText(JSON.stringify({ type: "error", code: "invalid_config" }))).toEqual({ kind: "error", code: "invalid_config" });
  });

  it("treats call_started/call_ended as control, clear_audio as a flush, and flags the rest", () => {
    expect(parseServerText('{"type":"call_started","call_id":"abc"}')).toMatchObject({ kind: "control", type: "call_started" });
    expect(parseServerText('{"type":"call_ended"}')).toMatchObject({ kind: "control", type: "call_ended" });
    expect(parseServerText('{"type":"clear_audio"}').kind).toBe("clear_audio");
    expect(parseServerText('{"type":"surprise","x":1}')).toMatchObject({ kind: "unknown", type: "surprise" });
    expect(parseServerText("not json").kind).toBe("unknown");
    expect(parseServerText("[1,2]").kind).toBe("unknown");
  });
});

describe("describeShape", () => {
  it("records structure without values", () => {
    expect(describeShape({ type: "audio", data: "secret-audio", n: 3, nested: { token: "wt_abc" } })).toEqual({ type: "audio", data: "string(12)", n: "number", nested: { token: "string(6)" } });
  });
});
