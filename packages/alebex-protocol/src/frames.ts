/**
 * Alebex Voice Engine browser-call frames.
 *
 * DOCUMENTED (AGENTS.md "Custom tools"): URL, `alebex.token.<token>` subprotocol,
 * `start_call {agent:{id}, customTools}`, `end_call`, and `error {code}` + close 1008
 * for a bad tool. Input audio is binary PCM16LE mono 16 kHz.
 *
 * CONFIRMED BY LIVE PROBE (scripts/probe-alebex-voice.ts, 2026-09-24; see
 * docs/ALEBEX_PROTOCOL_NOTES.md). This adapter accepts exactly these shapes:
 *   audio                {type, data: base64 PCM16LE, format: "pcm16", sample_rate: 24000}
 *   mark                 {type, name}                      → echo verbatim once heard
 *   clear_audio          {type}
 *   transcript           {type, role: "user", text, is_final}   (snapshot, assign)
 *   conversation_message {type, role: "assistant"|"user", content, timestamp}
 *   call_started         {type, call_id}
 *   call_ended           {type}                            (sent after end_call; the socket is NOT closed by the engine)
 *   error                {type, code, message}             (unknown agent: code "payload_unavailable", then close 1011)
 * Anything else is reported as `unknown` with its shape, never guessed at.
 */
import { z } from "zod";
import { base64ToBytes, OUTPUT_SAMPLE_RATE } from "./audio";

export const ALEBEX_WS_URL = "wss://api.voice.alebex.ai/public/ws/call";
export const ALEBEX_SUBPROTOCOL_PREFIX = "alebex.token.";

export function alebexSubprotocol(token: string): string {
  return `${ALEBEX_SUBPROTOCOL_PREFIX}${token}`;
}

export interface CustomToolDefinition {
  name: string;
  description: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  parameters: Record<string, unknown>;
}

export interface StartCallFrame {
  type: "start_call";
  agent: { id: string };
  customTools?: CustomToolDefinition[];
}

export const END_CALL_FRAME = { type: "end_call" } as const;

export function buildStartCall(agentId: string, customTools: CustomToolDefinition[]): StartCallFrame {
  const frame: StartCallFrame = { type: "start_call", agent: { id: agentId } };
  if (customTools.length > 0) frame.customTools = customTools;
  return frame;
}

export type Speaker = "user" | "agent";

export type AgentEvent =
  | { kind: "audio"; pcm: Uint8Array; sampleRate: number; variant: string }
  | { kind: "clear_audio" }
  | { kind: "mark"; raw: Record<string, unknown>; label: string }
  | { kind: "transcript"; role: Speaker; text: string; final: boolean; variant: string }
  | { kind: "conversation_message"; role: Speaker; text: string; id?: string; variant: string }
  | { kind: "error"; code?: string; message?: string }
  | { kind: "control"; type: string; raw: Record<string, unknown> }
  | { kind: "unknown"; type: string; raw: Record<string, unknown>; reason: string };

/** Confirmed control frames that carry nothing the UI must render. */
const PASSIVE_TYPES = new Set(["call_started", "call_ended"]);

const looseObject = z.record(z.string(), z.unknown());

const AudioFrame = z.object({ type: z.literal("audio"), data: z.string().min(1), format: z.literal("pcm16").optional(), sample_rate: z.number().int().positive().optional() });
const MarkFrame = z.object({ type: z.literal("mark"), name: z.string() });
const TranscriptFrame = z.object({ type: z.literal("transcript"), role: z.string(), text: z.string(), is_final: z.boolean().optional() });
const MessageFrame = z.object({ type: z.literal("conversation_message"), role: z.string(), content: z.string(), timestamp: z.string().optional(), id: z.string().optional() });
const ErrorFrame = z.object({ type: z.literal("error"), code: z.string().optional(), message: z.string().optional() });

function speaker(role: string): Speaker | null {
  if (role === "assistant" || role === "agent") return "agent";
  if (role === "user") return "user";
  return null;
}

/** Parse one text frame from the engine. Never throws. */
export function parseServerText(text: string): AgentEvent {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "unknown", type: "(non-json)", raw: {}, reason: "text frame was not JSON" };
  }
  const parsed = looseObject.safeParse(json);
  if (!parsed.success) return { kind: "unknown", type: "(non-object)", raw: {}, reason: "JSON frame was not an object" };
  return parseServerObject(parsed.data);
}

export function parseServerObject(obj: Record<string, unknown>): AgentEvent {
  const type = typeof obj.type === "string" ? obj.type : "(missing type)";
  const bad = (reason: string): AgentEvent => ({ kind: "unknown", type, raw: obj, reason });
  switch (type) {
    case "audio": {
      const f = AudioFrame.safeParse(obj);
      if (!f.success) return bad(obj.format !== undefined && obj.format !== "pcm16" ? `unsupported audio format "${String(obj.format)}"` : "audio frame does not match {data, format, sample_rate}");
      try {
        return { kind: "audio", pcm: base64ToBytes(f.data.data), sampleRate: f.data.sample_rate ?? OUTPUT_SAMPLE_RATE, variant: "json.data:base64" };
      } catch {
        return bad("audio payload was not valid base64");
      }
    }
    case "clear_audio":
      return { kind: "clear_audio" };
    case "mark": {
      const f = MarkFrame.safeParse(obj);
      return f.success ? { kind: "mark", raw: obj, label: f.data.name } : bad("mark frame without a string name");
    }
    case "transcript": {
      const f = TranscriptFrame.safeParse(obj);
      const role = f.success ? speaker(f.data.role) : null;
      if (!f.success || !role) return bad("transcript frame does not match {role, text, is_final}");
      return { kind: "transcript", role, text: f.data.text, final: f.data.is_final ?? false, variant: "role+text+is_final" };
    }
    case "conversation_message": {
      const f = MessageFrame.safeParse(obj);
      const role = f.success ? speaker(f.data.role) : null;
      if (!f.success || !role) return bad("conversation_message does not match {role, content}");
      return { kind: "conversation_message", role, text: f.data.content, ...(f.data.id ? { id: f.data.id } : {}), variant: "flat.content" };
    }
    case "error": {
      const f = ErrorFrame.safeParse(obj);
      if (!f.success) return { kind: "error" };
      return { kind: "error", ...(f.data.code ? { code: f.data.code } : {}), ...(f.data.message ? { message: f.data.message } : {}) };
    }
    default:
      if (PASSIVE_TYPES.has(type)) return { kind: "control", type, raw: obj };
      return bad("unrecognised frame type");
  }
}

/**
 * Describe a value's shape without its content: `{type:"audio", data:"string(4096)"}`.
 * Used by the probe and diagnostics so field layouts can be recorded without
 * logging secrets, transcripts or audio.
 */
export function describeShape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return depth > 2 ? `array(${value.length})` : [value.length ? describeShape(value[0], depth + 1) : "empty"];
  if (typeof value === "object") {
    if (depth > 3) return "object";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === "type" && typeof v === "string" ? v : describeShape(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return `string(${value.length})`;
  return typeof value;
}

/** Close codes worth branching on (AGENTS.md). */
export const CLOSE_POLICY_VIOLATION = 1008;
