/**
 * Alebex Voice Engine browser-call frames.
 *
 * DOCUMENTED (AGENTS.md, "Custom tools"): URL, `alebex.token.<token>` subprotocol,
 * `{"type":"start_call","agent":{"id"},"customTools":[...]}`, `{"type":"end_call"}`,
 * and `error` frames carrying a `code` (e.g. `invalid_config`, then close 1008).
 * Input audio is binary PCM16LE mono 16 kHz.
 *
 * NOT DOCUMENTED in any source available to this project: the field layout of
 * `audio`, `mark`, `transcript` and `conversation_message`. This module is the
 * ONLY place that knows about those layouts. It accepts the small set of
 * plausible encodings listed in docs/ALEBEX_PROTOCOL_NOTES.md, tags every parse
 * with the variant it matched, and reports anything else as `unknown` so the
 * probe and diagnostics can surface it rather than silently dropping it.
 */
import { z } from "zod";
import { base64ToBytes } from "./audio";

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
  | { kind: "audio"; pcm: Uint8Array; sampleRate?: number; variant: string }
  | { kind: "clear_audio" }
  | { kind: "mark"; raw: Record<string, unknown>; label: string }
  | { kind: "transcript"; role: Speaker; text: string; final: boolean; variant: string }
  | { kind: "conversation_message"; role: Speaker; text: string; id?: string; variant: string }
  | { kind: "error"; code?: string; message?: string }
  | { kind: "control"; type: string; raw: Record<string, unknown> }
  | { kind: "unknown"; type: string; raw: Record<string, unknown>; reason: string };

/** Frame types that are recognised but carry nothing the UI must act on. */
const PASSIVE_TYPES = new Set(["call_started", "call_ended", "ready", "ack", "ping", "pong", "metadata", "session", "vad"]);

const looseObject = z.record(z.string(), z.unknown());

function pickString(obj: Record<string, unknown>, keys: string[]): [string, string] | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return [k, v];
  }
  return null;
}

function normaliseRole(v: unknown): Speaker | null {
  if (typeof v !== "string") return null;
  const r = v.toLowerCase();
  if (["agent", "assistant", "bot", "ai", "model"].includes(r)) return "agent";
  if (["user", "customer", "caller", "human", "you"].includes(r)) return "user";
  return null;
}

function roleOf(obj: Record<string, unknown>): Speaker | null {
  return normaliseRole(obj.role) ?? normaliseRole(obj.speaker) ?? normaliseRole(obj.from) ?? normaliseRole(obj.source);
}

function finalOf(obj: Record<string, unknown>): boolean {
  if (typeof obj.final === "boolean") return obj.final;
  if (typeof obj.isFinal === "boolean") return obj.isFinal;
  if (typeof obj.is_final === "boolean") return obj.is_final;
  if (typeof obj.partial === "boolean") return !obj.partial;
  if (obj.transcriptType === "final" || obj.status === "final" || obj.state === "final") return true;
  return false;
}

function nested(obj: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const v = obj[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
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
  switch (type) {
    case "audio": {
      const hit = pickString(obj, ["data", "audio", "payload", "chunk", "pcm"]);
      const media = nested(obj, "media");
      const mediaHit = media ? pickString(media, ["payload", "data"]) : null;
      const source = hit ?? mediaHit;
      if (!source) return { kind: "unknown", type, raw: obj, reason: "audio frame without a base64 string field" };
      try {
        const pcm = base64ToBytes(source[1]);
        const rate =
          typeof obj.sampleRate === "number" ? obj.sampleRate : typeof obj.sample_rate === "number" ? obj.sample_rate : undefined;
        const variant = hit ? `json.${source[0]}:base64` : `json.media.${source[0]}:base64`;
        return rate === undefined ? { kind: "audio", pcm, variant } : { kind: "audio", pcm, sampleRate: rate, variant };
      } catch {
        return { kind: "unknown", type, raw: obj, reason: "audio payload was not valid base64" };
      }
    }
    case "clear_audio":
    case "clear":
      return { kind: "clear_audio" };
    case "mark": {
      const m = nested(obj, "mark");
      const label =
        pickString(obj, ["name", "id", "mark", "label"])?.[1] ?? (m ? pickString(m, ["name", "id"])?.[1] : undefined) ?? "";
      return { kind: "mark", raw: obj, label };
    }
    case "transcript":
    case "transcript_partial":
    case "transcript_final": {
      const role = roleOf(obj);
      const t = pickString(obj, ["text", "transcript", "content", "delta"]);
      if (!role || !t) return { kind: "unknown", type, raw: obj, reason: "transcript without recognisable role/text" };
      const final = type === "transcript_final" ? true : type === "transcript_partial" ? false : finalOf(obj);
      return { kind: "transcript", role, text: t[1], final, variant: `role+${t[0]}` };
    }
    case "conversation_message": {
      const msg = nested(obj, "message") ?? obj;
      const role = roleOf(msg);
      const t = pickString(msg, ["text", "content", "transcript"]);
      if (!role || !t) return { kind: "unknown", type, raw: obj, reason: "conversation_message without role/text" };
      const id = pickString(msg, ["id", "messageId", "item_id"])?.[1];
      const variant = msg === obj ? `flat.${t[0]}` : `message.${t[0]}`;
      return id ? { kind: "conversation_message", role, text: t[1], id, variant } : { kind: "conversation_message", role, text: t[1], variant };
    }
    case "error": {
      const code = pickString(obj, ["code", "error_code"])?.[1];
      const message = pickString(obj, ["message", "detail", "error"])?.[1];
      return { kind: "error", ...(code ? { code } : {}), ...(message ? { message } : {}) };
    }
    default:
      if (PASSIVE_TYPES.has(type)) return { kind: "control", type, raw: obj };
      return { kind: "unknown", type, raw: obj, reason: "unrecognised frame type" };
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
