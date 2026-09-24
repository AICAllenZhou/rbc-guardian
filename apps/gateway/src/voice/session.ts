/**
 * One browser voice call: browser socket ⇄ this state machine ⇄ Alebex socket.
 *
 *   idle → connecting_upstream → starting → active → ending → ended
 *                  └──────────────┴──────────┴──→ error → ended
 *
 * The Alebex token only ever appears in the upstream subprotocol. Mic audio is
 * forwarded as binary frames with backpressure; agent audio goes down as binary;
 * control frames are normalised by @guardian/alebex-protocol.
 */
import { WebSocket, type RawData } from "ws";
import {
  alebexSubprotocol,
  buildStartCall,
  CLOSE_POLICY_VIOLATION,
  END_CALL_FRAME,
  parseServerText,
  TranscriptStore,
  type AgentEvent,
  type CustomToolDefinition,
} from "@guardian/alebex-protocol";
import { AGENT_PERSONAS, ClientMessageSchema, CLOSE, redact, type ServerMessage, type SessionState, type VoiceSessionRecord } from "@guardian/shared";
import type { Store } from "../store";
import type { CaseService } from "../cases";
import type { Diagnostics } from "../diagnostics";
import type { Logger } from "../logger";
import { stableStringify } from "../tokens";

const TRANSITIONS: Record<SessionState, SessionState[]> = {
  idle: ["connecting_upstream", "ending", "error"],
  connecting_upstream: ["starting", "ending", "error"],
  starting: ["active", "ending", "error"],
  active: ["ending", "error"],
  ending: ["ended", "error"],
  error: ["ended"],
  ended: [],
};

export class InvalidTransitionError extends Error {}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface SessionLimits {
  maxDurationSec: number;
  maxAudioFrameBytes: number;
  maxMessagesPerSec: number;
  upstreamHighWaterBytes: number;
  endGraceMs: number;
  activateAfterMs: number;
  connectAttempts: number;
  backoffBaseMs: number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  maxDurationSec: 600,
  maxAudioFrameBytes: 32_000,
  maxMessagesPerSec: 80,
  upstreamHighWaterBytes: 512 * 1024,
  endGraceMs: 2_000,
  activateAfterMs: 1_500,
  connectAttempts: 3,
  backoffBaseMs: 400,
};

export interface VoiceSessionDeps {
  record: VoiceSessionRecord;
  upstreamUrl: string;
  token: string;
  agentId: string;
  customTools: CustomToolDefinition[];
  allowMockUtterances: boolean;
  store: Store;
  cases: CaseService;
  diag: Diagnostics;
  log: Logger;
  limits?: Partial<SessionLimits>;
  onFinished?: (id: string) => void;
}

export class VoiceSession {
  readonly id: string;
  private state: SessionState = "idle";
  private browser: WebSocket | null = null;
  private upstream: WebSocket | null = null;
  private readonly limits: SessionLimits;
  private readonly transcript = new TranscriptStore();
  private readonly outstandingMarks = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private rateWindowStart = Date.now();
  private rateCount = 0;
  private lastErrorCode: string | null = null;
  private startSent = false;
  readonly stats = { micFramesIn: 0, micFramesForwarded: 0, micFramesDropped: 0, audioChunksOut: 0, marksIn: 0, marksAcked: 0, startCallsSent: 0 };

  constructor(private readonly deps: VoiceSessionDeps) {
    this.id = deps.record.id;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  get currentState(): SessionState {
    return this.state;
  }

  attach(browser: WebSocket): void {
    if (this.browser) throw new Error("session already has a browser socket");
    this.browser = browser;
    browser.on("message", (data, isBinary) => this.onBrowserMessage(data, isBinary));
    browser.on("close", () => this.end("customer-ended-call (browser closed)"));
    browser.on("error", () => this.end("browser-socket-error"));
    this.timers.push(setTimeout(() => this.end("max-duration-reached"), this.limits.maxDurationSec * 1000));
    this.deps.cases.event(this.deps.cases.require(this.deps.record.caseId), this.id, "session_started", `${AGENT_PERSONAS[this.deps.record.role].name} call started`, `${AGENT_PERSONAS[this.deps.record.role].title} · ${this.deps.record.mode === "mock" ? "Mock voice runtime" : "Alebex Voice Engine"}${this.deps.customTools.length ? ` · ${this.deps.customTools.length} tools` : " · tools disabled"}`, "Guardian gateway");
    void this.connectUpstream(1);
  }

  private transition(to: SessionState, detail?: string): void {
    if (this.state === to) return;
    if (!canTransition(this.state, to)) throw new InvalidTransitionError(`${this.state} → ${to}`);
    this.state = to;
    this.deps.record.state = to;
    this.deps.store.putSession(this.deps.record);
    this.sendBrowser(detail ? { type: "state", state: to, detail } : { type: "state", state: to });
    this.deps.log.info("session.state", { sessionId: this.id, role: this.deps.record.role, state: to });
  }

  private async connectUpstream(attempt: number): Promise<void> {
    if (this.state === "ending" || this.state === "ended") return;
    if (this.state === "idle") this.transition("connecting_upstream");
    const t0 = Date.now();
    const ws = new WebSocket(this.deps.upstreamUrl, [alebexSubprotocol(this.deps.token)], { handshakeTimeout: 8_000, maxPayload: 8 * 1024 * 1024 });
    this.upstream = ws;

    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      const reason = res.statusMessage ?? "";
      ws.removeAllListeners("close");
      ws.on("error", () => undefined);
      ws.terminate();
      this.deps.diag.counters.upstreamErrors++;
      this.deps.log.warn("upstream.rejected", { sessionId: this.id, status, reason, attempt });
      const capacity = status === 429 || status === 503 || /capacity|too many/i.test(reason);
      if (capacity && attempt < this.limits.connectAttempts && !this.startSent) {
        const delay = this.limits.backoffBaseMs * 2 ** (attempt - 1);
        this.sendBrowser({ type: "state", state: "connecting_upstream", detail: `Alebex is busy; retrying in ${Math.round(delay / 100) / 10}s` });
        this.timers.push(setTimeout(() => void this.connectUpstream(attempt + 1), delay));
        return;
      }
      if (status === 401 || status === 403) this.fail("upstream_auth", "Alebex refused the voice token. Check ALEBEX_API_KEY in the gateway .env.", CLOSE.upstreamAuth, false);
      else if (capacity) this.fail("upstream_capacity", "Alebex is at capacity. Wait a moment and call again.", CLOSE.upstreamCapacity, true);
      else this.fail("upstream_rejected", `Alebex rejected the connection (HTTP ${status}).`, CLOSE.upstreamLost, true);
    });

    ws.on("open", () => {
      if (this.state !== "connecting_upstream") {
        ws.close();
        return;
      }
      this.deps.log.info("upstream.open", { sessionId: this.id, latencyMs: Date.now() - t0 });
      this.transition("starting");
      this.startSent = true;
      this.stats.startCallsSent++;
      ws.send(JSON.stringify(buildStartCall(this.deps.agentId, this.deps.customTools)));
      this.timers.push(setTimeout(() => this.activate(), this.limits.activateAfterMs));
    });

    ws.on("message", (data, isBinary) => this.onUpstreamMessage(data, isBinary));
    ws.on("error", (err) => this.deps.log.warn("upstream.error", { sessionId: this.id, error: err.message }));
    ws.on("close", (code, reasonBuf) => this.onUpstreamClose(code, reasonBuf.toString("utf8").slice(0, 120)));
  }

  private activate(): void {
    if (this.state === "starting") this.transition("active");
  }

  private onUpstreamMessage(data: RawData, isBinary: boolean): void {
    if (this.state === "ended") return;
    if (isBinary) {
      this.activate();
      this.deps.diag.recordVariant("audio", "binary");
      this.stats.audioChunksOut++;
      this.sendBrowserBinary(toBuffer(data));
      return;
    }
    const event = parseServerText(toBuffer(data).toString("utf8"));
    if (event.kind !== "error") this.activate();
    this.handleEvent(event);
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.kind) {
      case "audio":
        this.deps.diag.recordVariant("audio", event.variant);
        this.stats.audioChunksOut++;
        this.sendBrowserBinary(Buffer.from(event.pcm.buffer, event.pcm.byteOffset, event.pcm.byteLength));
        return;
      case "clear_audio":
        this.sendBrowser({ type: "clear_audio" });
        return;
      case "mark":
        this.stats.marksIn++;
        this.outstandingMarks.add(stableStringify(event.raw));
        this.sendBrowser({ type: "mark", mark: event.raw });
        return;
      case "transcript":
        this.deps.diag.recordVariant("transcript", event.variant);
        this.sendBrowser({ type: "transcript", role: event.role, text: event.text, final: event.final });
        if (event.final && this.transcript.final(event.role, event.text)) this.persistMessage(event.role, event.text);
        return;
      case "conversation_message": {
        this.deps.diag.recordVariant("conversation_message", event.variant);
        if (this.transcript.commit(event.role, event.text, event.id)) {
          const last = this.transcript.messages[this.transcript.messages.length - 1];
          this.sendBrowser({ type: "message", role: event.role, text: event.text, id: last?.id ?? `${Date.now()}` });
          this.persistMessage(event.role, event.text);
        }
        return;
      }
      case "error":
        this.lastErrorCode = event.code ?? "error";
        this.deps.diag.counters.upstreamErrors++;
        this.deps.log.warn("upstream.error_frame", { sessionId: this.id, code: event.code });
        this.sendBrowser({ type: "error", code: event.code ?? "alebex_error", message: humanError(event.code, event.message), recoverable: !["invalid_config", "payload_unavailable", "AGENT_NOT_FOUND", "AGENT_NOT_IN_ACCOUNT"].includes(event.code ?? "") });
        return;
      case "control":
        return;
      case "unknown":
        if (event.type === "mock_hint") {
          // Mock-runtime extension (suggested replies); never produced by the real engine.
          if (this.deps.allowMockUtterances && Array.isArray(event.raw.replies)) {
            this.sendBrowser({ type: "hint", replies: event.raw.replies.filter((r): r is string => typeof r === "string").slice(0, 4) });
          }
          return;
        }
        this.deps.diag.recordUnknown(event.type, event.reason, event.raw);
        this.deps.log.warn("upstream.unknown_frame", { sessionId: this.id, type: event.type, reason: event.reason });
        return;
    }
  }

  private persistMessage(role: "user" | "agent", text: string): void {
    this.deps.store.addMessage({ sessionId: this.id, caseId: this.deps.record.caseId, role, text: redact(text), at: new Date().toISOString() });
  }

  private onBrowserMessage(data: RawData, isBinary: boolean): void {
    if (!this.withinRate()) {
      this.fail("rate_limited", "Too many messages from the browser.", CLOSE_POLICY_VIOLATION, false);
      return;
    }
    if (isBinary) {
      const buf = toBuffer(data);
      this.stats.micFramesIn++;
      if (buf.byteLength === 0 || buf.byteLength % 2 !== 0 || buf.byteLength > this.limits.maxAudioFrameBytes) {
        this.stats.micFramesDropped++;
        return;
      }
      const up = this.upstream;
      if (!up || up.readyState !== WebSocket.OPEN || (this.state !== "starting" && this.state !== "active")) {
        this.stats.micFramesDropped++;
        return;
      }
      if (up.bufferedAmount > this.limits.upstreamHighWaterBytes) {
        // Backpressure: drop rather than build latency. Stale mic audio is worse than a gap.
        this.stats.micFramesDropped++;
        this.deps.diag.counters.micFramesDropped++;
        return;
      }
      up.send(buf, { binary: true });
      this.stats.micFramesForwarded++;
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(toBuffer(data).toString("utf8"));
    } catch {
      return;
    }
    const msg = ClientMessageSchema.safeParse(json);
    if (!msg.success) return;
    switch (msg.data.type) {
      case "mark_played": {
        const key = stableStringify(msg.data.mark);
        // Only echo marks the engine actually sent, once each. A mark flushed by clear_audio is never echoed by the browser.
        if (!this.outstandingMarks.delete(key)) return;
        this.stats.marksAcked++;
        this.sendUpstream(JSON.stringify(msg.data.mark));
        return;
      }
      case "end":
        this.end("customer-ended-call");
        return;
      case "ping":
        this.sendBrowser({ type: "pong" });
        return;
      case "mock_utterance":
        if (this.deps.allowMockUtterances) this.sendUpstream(JSON.stringify({ type: "mock_user_utterance", text: msg.data.text }));
        return;
    }
  }

  private withinRate(): boolean {
    const now = Date.now();
    if (now - this.rateWindowStart >= 1000) {
      this.rateWindowStart = now;
      this.rateCount = 0;
    }
    return ++this.rateCount <= this.limits.maxMessagesPerSec;
  }

  private onUpstreamClose(code: number, reason: string): void {
    this.deps.log.info("upstream.close", { sessionId: this.id, code, reason });
    if (this.state === "ending") {
      this.finish(this.deps.record.endReason ?? "customer-ended-call");
      return;
    }
    if (this.state === "ended" || this.state === "error") return;
    // An error frame followed by a close is a refusal of this call's setup. Observed live (probe, 2026-09-24):
    // a nonexistent agent ID → {"type":"error","code":"payload_unavailable"} then close 1011.
    // Documented: a bad customTools entry → code "invalid_config" then close 1008.
    if (code === CLOSE_POLICY_VIOLATION || this.lastErrorCode) {
      this.fail(this.lastErrorCode ?? "upstream_policy", humanError(this.lastErrorCode ?? undefined, undefined), CLOSE.upstreamConfig, false);
      return;
    }
    if (code === 1000) {
      // The engine ended the call itself (e.g. the agent said goodbye).
      this.transition("ending");
      this.finish("assistant-ended-call");
      return;
    }
    this.fail("upstream_lost", "The connection to Alebex dropped. You can start a new call; completed actions are kept.", CLOSE.upstreamLost, true);
  }

  /** Graceful end: send end_call, wait briefly for the engine to close, then clean up both sides. */
  end(reason: string): void {
    if (this.state === "ended" || this.state === "ending" || this.state === "error") {
      if (this.state === "error") this.finish(this.deps.record.endReason ?? reason);
      return;
    }
    this.deps.record.endReason = reason;
    this.transition("ending");
    const up = this.upstream;
    if (up && up.readyState === WebSocket.OPEN) {
      up.send(JSON.stringify(END_CALL_FRAME));
      this.timers.push(setTimeout(() => {
        up.terminate();
        this.finish(reason);
      }, this.limits.endGraceMs));
    } else {
      up?.terminate();
      this.finish(reason);
    }
  }

  private fail(code: string, message: string, closeCode: number, recoverable: boolean): void {
    if (this.state === "ended" || this.state === "error") return;
    this.deps.record.endReason = `error:${code}`;
    this.sendBrowser({ type: "error", code, message, recoverable });
    this.transition("error", message);
    this.finish(`error:${code}`, closeCode);
  }

  private finish(reason: string, closeCode: number = CLOSE.normal): void {
    if (this.state === "ended") return;
    if (this.state !== "error" && this.state !== "ending") this.state = "ending";
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.outstandingMarks.clear();
    this.deps.record.endedAt = new Date().toISOString();
    this.deps.record.endReason = reason;
    this.transition("ended");
    this.sendBrowser({ type: "ended", reason });
    const c = this.deps.store.getCase(this.deps.record.caseId);
    if (c) this.deps.cases.event(c, this.id, "session_ended", `${AGENT_PERSONAS[this.deps.record.role].name} call ended`, reason, "Guardian gateway");
    const up = this.upstream;
    if (up && up.readyState !== WebSocket.CLOSED) {
      up.removeAllListeners("close");
      up.on("error", () => undefined);
      if (up.readyState === WebSocket.OPEN) up.close(1000);
      else up.terminate();
    }
    if (this.browser && this.browser.readyState === WebSocket.OPEN) this.browser.close(closeCode, reason.slice(0, 100));
    this.deps.log.info("session.finished", { sessionId: this.id, reason, ...this.stats });
    this.deps.onFinished?.(this.id);
  }

  private sendUpstream(text: string): void {
    const up = this.upstream;
    if (up && up.readyState === WebSocket.OPEN) up.send(text);
  }

  private sendBrowser(msg: ServerMessage): void {
    const b = this.browser;
    if (b && b.readyState === WebSocket.OPEN) b.send(JSON.stringify(msg));
  }

  private sendBrowserBinary(buf: Buffer): void {
    const b = this.browser;
    if (b && b.readyState === WebSocket.OPEN) b.send(buf, { binary: true });
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function humanError(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "invalid_config":
      return "Alebex refused the call setup (agent ID or tool definitions). See developer diagnostics.";
    case "AGENT_NOT_FOUND":
    case "AGENT_NOT_IN_ACCOUNT":
    case "payload_unavailable":
      return "Alebex could not load this agent. Check that the agent ID exists in your Alebex console account.";
    case undefined:
      return "Alebex closed the call (policy violation: token or configuration).";
    case "at_capacity":
      return "Alebex is at its concurrent-call limit. Try again shortly.";
    default:
      return message ? `Alebex: ${message.slice(0, 200)}` : "Alebex reported an error.";
  }
}
