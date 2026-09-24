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

describe("parseServerText", () => {
  it("decodes base64 audio in data/audio/payload/media.payload", () => {
    const b64 = Buffer.from([1, 0, 2, 0]).toString("base64");
    for (const frame of [{ type: "audio", data: b64 }, { type: "audio", audio: b64 }, { type: "audio", payload: b64 }, { type: "audio", media: { payload: b64 } }]) {
      const e = parseServerText(JSON.stringify(frame));
      expect(e.kind).toBe("audio");
      if (e.kind === "audio") expect(Array.from(e.pcm)).toEqual([1, 0, 2, 0]);
    }
  });

  it("reports audio without a payload as unknown instead of throwing", () => {
    expect(parseServerText(JSON.stringify({ type: "audio" })).kind).toBe("unknown");
    expect(parseServerText(JSON.stringify({ type: "audio", data: "@@@" })).kind).toBe("unknown");
  });

  it("keeps mark frames verbatim for echo", () => {
    const e = parseServerText(JSON.stringify({ type: "mark", name: "utt-1", extra: 3 }));
    expect(e).toEqual({ kind: "mark", raw: { type: "mark", name: "utt-1", extra: 3 }, label: "utt-1" });
  });

  it("normalises transcript roles and finality", () => {
    const partial = parseServerText(JSON.stringify({ type: "transcript", role: "assistant", text: "Hello" }));
    expect(partial).toMatchObject({ kind: "transcript", role: "agent", text: "Hello", final: false });
    const fin = parseServerText(JSON.stringify({ type: "transcript", speaker: "user", transcript: "Hi", isFinal: true }));
    expect(fin).toMatchObject({ kind: "transcript", role: "user", text: "Hi", final: true });
  });

  it("reads conversation_message flat or nested", () => {
    expect(parseServerText(JSON.stringify({ type: "conversation_message", role: "agent", content: "Hi" }))).toMatchObject({ kind: "conversation_message", role: "agent", text: "Hi" });
    expect(parseServerText(JSON.stringify({ type: "conversation_message", message: { role: "user", text: "Yo", id: "m1" } }))).toMatchObject({ kind: "conversation_message", role: "user", text: "Yo", id: "m1" });
  });

  it("parses documented error frames", () => {
    expect(parseServerText(JSON.stringify({ type: "error", code: "invalid_config", message: "bad" }))).toEqual({ kind: "error", code: "invalid_config", message: "bad" });
  });

  it("recognises clear_audio and flags unknown types", () => {
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
