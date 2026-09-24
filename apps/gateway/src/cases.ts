/**
 * Mock "RBC Core": the only code that mutates fraud-case state. Tool handlers,
 * operator actions and the demo controls all go through here, so every change
 * is audited as a CaseEvent and pushed to the SSE timeline.
 */
import { randomUUID, randomInt } from "node:crypto";
import {
  assessRisk,
  AGENT_PERSONAS,
  formatCad,
  redact,
  type AgentRole,
  type CaseEvent,
  type CaseEventType,
  type CustomerResponseType,
  type GuardianCase,
  type RiskAssessment,
} from "@guardian/shared";
import type { Store } from "./store";
import type { EventBus } from "./events";
import { makeReversePhrase, SEED_CASE_ID, SEED_CUSTOMER, SEED_CUSTOMER_ID, SEED_TXN_ID, seedTransactions } from "./seed";

export class CaseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function actorFor(role: AgentRole | "operator" | "system"): string {
  if (role === "operator") return "Demo operator";
  if (role === "system") return "Guardian fraud engine (mock)";
  return `${AGENT_PERSONAS[role].name} · ${AGENT_PERSONAS[role].title}`;
}

export class CaseService {
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly random: () => number = Math.random,
  ) {}

  /** Idempotent: seeds the customer and transactions if absent. */
  ensureSeed(): void {
    if (!this.store.getCustomer(SEED_CUSTOMER_ID)) this.resetDemo();
  }

  resetDemo(): void {
    this.store.resetAll();
    this.store.putCustomer(SEED_CUSTOMER);
    for (const t of seedTransactions()) this.store.putTransaction(t);
    this.bus.publish("*", { kind: "reset" });
  }

  /** The mock fraud engine flags the Miami purchase and opens GUARD-4821. */
  detect(): GuardianCase {
    this.ensureSeed();
    const existing = this.store.getCase(SEED_CASE_ID);
    if (existing) return existing;
    const txn = this.store.getTransaction(SEED_TXN_ID);
    if (!txn) throw new CaseError(500, "seed transaction missing");
    const now = new Date().toISOString();
    const risk = assessRisk(SEED_CUSTOMER, txn, []);
    const c: GuardianCase = {
      id: SEED_CASE_ID,
      customerId: SEED_CUSTOMER_ID,
      transactionId: txn.id,
      channel: "sentinel_alert",
      status: "open",
      summary: `${formatCad(txn.amountCents)} at ${txn.merchant}, ${txn.city} ${txn.region}, from an unknown device.`,
      riskScore: risk.score,
      riskHistory: [{ at: now, score: risk.score, reason: "Initial fraud-engine assessment" }],
      cardLocked: false,
      transactionFlagged: false,
      reverseAuth: null,
      humanReview: null,
      responses: [],
      createdAt: now,
      updatedAt: now,
    };
    this.store.putCase(c);
    this.event(c, null, "detection", "Suspicious transaction detected", `${c.summary} Risk ${risk.score}/99 (${risk.band}).`, actorFor("system"), risk.score);
    this.publishCase(c);
    return c;
  }

  /** TrustLine calls start with an intake case the agent fills in with create_guardian_case. */
  createIntakeCase(): GuardianCase {
    this.ensureSeed();
    let id = "";
    do id = `GUARD-${randomInt(1000, 9999)}`;
    while (id === SEED_CASE_ID || this.store.getCase(id));
    const now = new Date().toISOString();
    const risk = assessRisk(SEED_CUSTOMER, null, []);
    const c: GuardianCase = {
      id,
      customerId: SEED_CUSTOMER_ID,
      transactionId: null,
      channel: "other",
      status: "intake",
      summary: "Customer-initiated TrustLine call. Awaiting report details.",
      riskScore: risk.score,
      riskHistory: [{ at: now, score: risk.score, reason: "Intake" }],
      cardLocked: false,
      transactionFlagged: false,
      reverseAuth: null,
      humanReview: null,
      responses: [],
      createdAt: now,
      updatedAt: now,
    };
    this.store.putCase(c);
    this.event(c, null, "case_created", "TrustLine intake opened", "The customer called Guardian TrustLine.", actorFor("system"));
    this.publishCase(c);
    return c;
  }

  require(caseId: string): GuardianCase {
    const c = this.store.getCase(caseId);
    if (!c) throw new CaseError(404, `Case ${caseId} was not found in the demo sandbox.`);
    return c;
  }

  assess(c: GuardianCase): RiskAssessment {
    const customer = this.store.getCustomer(c.customerId) ?? SEED_CUSTOMER;
    const txn = c.transactionId ? this.store.getTransaction(c.transactionId) : null;
    return assessRisk(customer, txn, c.responses);
  }

  view(caseId: string) {
    const c = this.require(caseId);
    return {
      case: c,
      customer: this.store.getCustomer(c.customerId),
      transaction: c.transactionId ? this.store.getTransaction(c.transactionId) : null,
      assessment: this.assess(c),
      events: this.store.listEvents(caseId),
      tools: this.store.listToolInvocations(caseId),
      sessions: this.store.listSessions(caseId),
      messages: this.store.listMessages(caseId),
    };
  }

  issueReverseAuth(caseId: string, sessionId: string | null, actor: string): { phrase: string; reused: boolean } {
    const c = this.require(caseId);
    if (c.reverseAuth && !c.reverseAuth.verified && sessionId && c.reverseAuth.issuedAt >= (this.store.getSession(sessionId)?.startedAt ?? "")) {
      return { phrase: c.reverseAuth.phrase, reused: true };
    }
    let phrase = makeReversePhrase(this.random);
    if (phrase === c.reverseAuth?.phrase) phrase = makeReversePhrase(this.random);
    c.reverseAuth = { phrase, issuedAt: new Date().toISOString(), verified: false };
    this.save(c);
    this.event(c, sessionId, "reverse_auth_issued", "Reverse-authentication phrase issued", `Phrase shown in the customer's Guardian app: ${phrase}`, actor);
    return { phrase, reused: false };
  }

  recordResponse(caseId: string, type: CustomerResponseType, note: string | undefined, sessionId: string | null, actor: string): { assessment: RiskAssessment; changed: boolean } {
    const c = this.require(caseId);
    const safeNote = note ? redact(note).slice(0, 300) : undefined;
    c.responses.push({ type, at: new Date().toISOString(), ...(safeNote ? { note: safeNote } : {}), ...(sessionId ? { sessionId } : {}) });
    if (type === "confirmed_reverse_auth" && c.reverseAuth) {
      c.reverseAuth.verified = true;
      this.event(c, sessionId, "reverse_auth_verified", "Customer verified the bank", `The customer confirmed the phrase ${c.reverseAuth.phrase} matches their app.`, actor);
    }
    this.event(c, sessionId, "customer_response", RESPONSE_TITLES[type], safeNote ?? "", actor);
    const changed = this.recompute(c, sessionId, RESPONSE_TITLES[type]);
    this.save(c);
    return { assessment: this.assess(c), changed };
  }

  openReportedCase(
    caseId: string,
    args: { contact_channel: GuardianCase["channel"]; summary: string; claimed_organization?: string; requested_sensitive_info?: boolean },
    sessionId: string | null,
    actor: string,
  ): GuardianCase {
    const c = this.require(caseId);
    c.channel = args.contact_channel;
    const claimed = args.claimed_organization ? ` Claimed to be: ${redact(args.claimed_organization)}.` : "";
    c.summary = `${redact(args.summary).slice(0, 400)}${claimed}`;
    if (c.status === "intake") c.status = "open";
    if (args.requested_sensitive_info) {
      c.responses.push({ type: "was_asked_for_code", at: new Date().toISOString(), note: "Reported when the case was opened", ...(sessionId ? { sessionId } : {}) });
    }
    if (args.claimed_organization && /rbc|royal|bank|guardian|fraud/i.test(args.claimed_organization)) {
      c.responses.push({ type: "reported_impersonation_call", at: new Date().toISOString(), note: "Contact claimed to be the bank", ...(sessionId ? { sessionId } : {}) });
    }
    this.event(c, sessionId, "case_created", "Guardian case opened from customer report", c.summary, actor);
    this.recompute(c, sessionId, "Customer report");
    this.save(c);
    return c;
  }

  lockCard(caseId: string, reason: string, sessionId: string | null, actor: string): { alreadyLocked: boolean; case: GuardianCase } {
    const c = this.require(caseId);
    if (c.cardLocked) return { alreadyLocked: true, case: c };
    c.cardLocked = true;
    if (c.status === "open" || c.status === "intake") c.status = "protected";
    this.event(c, sessionId, "card_locked", "Temporary card lock applied (mock)", `Card ending ${SEED_CUSTOMER.cardLast4} locked in the sandbox. Reason: ${redact(reason)}`, actor);
    this.save(c);
    return { alreadyLocked: false, case: c };
  }

  flagTransaction(caseId: string, transactionId: string | undefined, reason: string, sessionId: string | null, actor: string) {
    const c = this.require(caseId);
    const txnId = transactionId?.trim() || c.transactionId;
    if (!txnId) throw new CaseError(404, "This case has no transaction to flag.");
    if (txnId !== c.transactionId) throw new CaseError(404, `Transaction ${txnId} is not on case ${c.id}.`);
    const txn = this.store.getTransaction(txnId);
    if (!txn) throw new CaseError(404, `Transaction ${txnId} was not found.`);
    if (c.transactionFlagged) return { alreadyFlagged: true, case: c, transaction: txn };
    c.transactionFlagged = true;
    txn.status = "flagged";
    this.store.putTransaction(txn);
    if (c.status === "open") c.status = "protected";
    this.event(c, sessionId, "transaction_flagged", "Transaction flagged as suspected fraud (mock)", `${formatCad(txn.amountCents)} at ${txn.merchant}, ${txn.city}. ${redact(reason)}`, actor);
    this.save(c);
    return { alreadyFlagged: false, case: c, transaction: txn };
  }

  requestReview(caseId: string, priority: "standard" | "urgent", summary: string, sessionId: string | null, actor: string) {
    const c = this.require(caseId);
    if (c.humanReview) return { already: true, case: c };
    c.humanReview = { ticketId: `HR-${randomInt(10_000, 99_999)}`, priority, status: "queued", summary: redact(summary).slice(0, 400), requestedAt: new Date().toISOString() };
    c.status = "review_requested";
    this.event(c, sessionId, "human_review_requested", `Human review requested (${priority})`, `Ticket ${c.humanReview.ticketId} queued for a fraud specialist (mock queue).`, actor);
    this.save(c);
    return { already: false, case: c };
  }

  event(c: GuardianCase, sessionId: string | null, type: CaseEventType, title: string, detail: string, actor: string, riskScore?: number): CaseEvent {
    const e: CaseEvent = { id: randomUUID(), caseId: c.id, sessionId, type, title, detail, actor, at: new Date().toISOString(), ...(riskScore !== undefined ? { riskScore } : {}) };
    this.store.addEvent(e);
    this.bus.publish(c.id, { kind: "event", event: e });
    return e;
  }

  private recompute(c: GuardianCase, sessionId: string | null, reason: string): boolean {
    const next = this.assess(c).score;
    if (next === c.riskScore) return false;
    const prev = c.riskScore;
    c.riskScore = next;
    c.riskHistory.push({ at: new Date().toISOString(), score: next, reason });
    this.event(c, sessionId, "risk_changed", `Risk ${prev} → ${next}`, reason, actorFor("system"), next);
    return true;
  }

  private save(c: GuardianCase): void {
    c.updatedAt = new Date().toISOString();
    this.store.putCase(c);
    this.publishCase(c);
  }

  private publishCase(c: GuardianCase): void {
    this.bus.publish(c.id, { kind: "case", case: c });
  }
}

const RESPONSE_TITLES: Record<CustomerResponseType, string> = {
  recognizes_transaction: "Customer recognises the transaction",
  denies_transaction: "Customer does not recognise the transaction",
  reported_impersonation_call: "Customer reports a bank-impersonation contact",
  was_asked_for_code: "Customer was asked for a verification code",
  shared_code: "Customer shared a verification code",
  confirmed_reverse_auth: "Reverse authentication confirmed",
  reverse_auth_mismatch: "Reverse-authentication phrase did not match",
  other: "Customer response recorded",
};
