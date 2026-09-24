import { randomBytes, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { OUTPUT_SAMPLE_RATE } from "@guardian/alebex-protocol";
import { AGENT_PERSONAS, CLOSE, type AgentRole, type CreateSessionResponse, type VoiceSessionRecord } from "@guardian/shared";
import type { GatewayConfig } from "../env";
import type { Store } from "../store";
import { CaseError, type CaseService } from "../cases";
import type { Diagnostics } from "../diagnostics";
import type { Logger } from "../logger";
import { buildCustomTools } from "../tools/definitions";
import { mintTicket, verifyTicket } from "../tokens";
import { SEED_CASE_ID } from "../seed";
import { VoiceSession, type SessionLimits } from "./session";

export const MAX_CONCURRENT_SESSIONS = 3;
const TICKET_TTL_SEC = 60;
export const MOCK_TOKEN = "mock-runtime-token";

export interface ManagerDeps {
  cfg: GatewayConfig;
  store: Store;
  cases: CaseService;
  diag: Diagnostics;
  log: Logger;
  /** Resolved at startup in mock mode. */
  mockUpstreamUrl?: string;
  limits?: Partial<SessionLimits>;
}

export class SessionManager {
  private readonly live = new Map<string, VoiceSession>();
  private readonly pending = new Map<string, VoiceSessionRecord>();
  private readonly usedTickets = new Set<string>();

  constructor(private readonly deps: ManagerDeps) {}

  get activeCount(): number {
    return this.live.size;
  }

  get(id: string): VoiceSession | undefined {
    return this.live.get(id);
  }

  /** Resolve the Alebex agent ID for a role. Mock agents are named so the mock engine can pick a persona. */
  agentIdFor(role: AgentRole): string | null {
    if (this.deps.cfg.mode === "mock") return `mock-agent-${role}`;
    return this.deps.cfg.agents[role];
  }

  create(role: AgentRole, requestedCaseId?: string): CreateSessionResponse {
    const { cfg, cases } = this.deps;
    if (!this.agentIdFor(role)) throw new CaseError(503, `No Alebex agent is configured for ${AGENT_PERSONAS[role].title}. Set ALEBEX_AGENT_${role.toUpperCase()}_ID or ALEBEX_AGENT_DEFAULT_ID.`);
    if (this.live.size + this.pending.size >= MAX_CONCURRENT_SESSIONS) {
      this.expirePending();
      if (this.live.size + this.pending.size >= MAX_CONCURRENT_SESSIONS) throw new CaseError(429, "Too many concurrent demo calls. End the other call first.");
    }
    cases.ensureSeed();
    let caseId: string;
    if (role === "sentinel") {
      caseId = requestedCaseId ?? SEED_CASE_ID;
      if (!this.deps.store.getCase(caseId)) throw new CaseError(409, "Trigger the suspicious-transaction detection before answering the Sentinel call.");
    } else if (role === "recovery") {
      const c = requestedCaseId ? this.deps.store.getCase(requestedCaseId) : this.deps.store.listCases().find((x) => x.status !== "intake");
      if (!c) throw new CaseError(409, "Recovery needs an existing case. Run the Sentinel or TrustLine flow first.");
      caseId = c.id;
    } else {
      caseId = requestedCaseId && this.deps.store.getCase(requestedCaseId) ? requestedCaseId : cases.createIntakeCase().id;
    }

    const id = `vs_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const toolsEnabled = cfg.mode !== "live-voice-only";
    const record: VoiceSessionRecord = { id, role, caseId, mode: cfg.mode, state: "idle", toolsEnabled, startedAt: new Date().toISOString(), endedAt: null, endReason: null };
    this.deps.store.putSession(record);
    this.pending.set(id, record);
    const ticket = mintTicket(cfg.signingSecret, { sid: id, exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SEC, n: randomBytes(8).toString("hex") });
    this.deps.diag.counters.sessions++;
    this.deps.log.info("session.created", { sessionId: id, role, caseId, mode: cfg.mode, toolsEnabled });
    return {
      sessionId: id,
      ticket,
      caseId,
      role,
      agentName: AGENT_PERSONAS[role].name,
      mode: cfg.mode,
      toolsEnabled,
      singleAgentFallback: cfg.singleAgentFallback,
      wsPath: `/voice?sid=${encodeURIComponent(id)}`,
      outputSampleRate: OUTPUT_SAMPLE_RATE,
      maxDurationSec: cfg.maxSessionSec,
    };
  }

  /** Validate a browser upgrade. Returns a close code on failure. */
  attach(ws: WebSocket, sid: string, ticket: string): number | null {
    const v = verifyTicket(this.deps.cfg.signingSecret, ticket);
    if (!v.ok || v.claims.sid !== sid) return CLOSE.badTicket;
    if (this.usedTickets.has(v.claims.n)) return CLOSE.badTicket; // single use: blocks stale reconnect attempts
    const record = this.pending.get(sid);
    if (!record) return this.live.has(sid) ? CLOSE.sessionBusy : CLOSE.badTicket;
    this.usedTickets.add(v.claims.n);
    this.pending.delete(sid);

    const { cfg } = this.deps;
    const mock = cfg.mode === "mock";
    const baseUrl = mock ? cfg.gatewayOrigin : cfg.publicToolBaseUrl;
    const customTools =
      record.toolsEnabled && baseUrl
        ? buildCustomTools({ role: record.role, sessionId: sid, baseUrl, signingSecret: cfg.signingSecret, ttlSec: cfg.maxSessionSec + 300 })
        : [];
    const session = new VoiceSession({
      record,
      upstreamUrl: mock ? (this.deps.mockUpstreamUrl ?? "") : cfg.upstreamUrl,
      token: mock ? MOCK_TOKEN : (cfg.alebexToken ?? ""),
      agentId: this.agentIdFor(record.role) ?? "",
      customTools,
      allowMockUtterances: mock,
      store: this.deps.store,
      cases: this.deps.cases,
      diag: this.deps.diag,
      log: this.deps.log,
      limits: { maxDurationSec: cfg.maxSessionSec, ...this.deps.limits },
      onFinished: (id) => this.live.delete(id),
    });
    this.live.set(sid, session);
    session.attach(ws);
    return null;
  }

  endAll(reason: string): void {
    for (const s of this.live.values()) s.end(reason);
  }

  /** End every call and wait (bounded) until each has cleaned up. */
  async drain(reason: string, timeoutMs = 3_000): Promise<void> {
    this.endAll(reason);
    const deadline = Date.now() + timeoutMs;
    while (this.live.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  }

  private expirePending(): void {
    const cutoff = Date.now() - TICKET_TTL_SEC * 1000;
    for (const [id, r] of this.pending) {
      if (Date.parse(r.startedAt) < cutoff) {
        this.pending.delete(id);
        r.state = "ended";
        r.endedAt = new Date().toISOString();
        r.endReason = "never-connected";
        this.deps.store.putSession(r);
      }
    }
  }
}
