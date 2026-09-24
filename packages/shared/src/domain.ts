import { z } from "zod";

export const DISCLAIMER = "Hackathon concept demo. Not an official RBC product. No real banking action is performed.";

export const AgentRoleSchema = z.enum(["trustline", "sentinel", "recovery"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export interface AgentPersona {
  role: AgentRole;
  name: string;
  title: string;
  direction: "inbound" | "outbound" | "handoff";
  voice: string;
  summary: string;
  accent: "gold" | "blue" | "teal";
}

export const AGENT_PERSONAS: Record<AgentRole, AgentPersona> = {
  trustline: {
    role: "trustline",
    name: "Maya",
    title: "Guardian TrustLine",
    direction: "inbound",
    voice: "Warm, reassuring, unhurried",
    summary: "Takes your call when something feels off. Helps you report a suspicious call or message, opens a case and proves she is the bank before asking you anything.",
    accent: "gold",
  },
  sentinel: {
    role: "sentinel",
    name: "Atlas",
    title: "Fraud Sentinel",
    direction: "outbound",
    voice: "Calm, concise, professional",
    summary: "Reaches out when the fraud engine flags a transaction. Authenticates himself to you first, then asks whether you recognise the activity and protects the card with your approval.",
    accent: "blue",
  },
  recovery: {
    role: "recovery",
    name: "Nora",
    title: "Recovery Specialist",
    direction: "handoff",
    voice: "Empathetic, patient, recovery-focused",
    summary: "Picks up an existing case, explains what has already been protected and walks you through a simple recovery checklist.",
    accent: "teal",
  },
};

export type CaseStatus = "intake" | "open" | "protected" | "review_requested" | "resolved";

export interface CustomerProfile {
  id: string;
  name: string;
  homeCity: string;
  homeRegion: string;
  homeCountry: string;
  /** Typical single purchase, in cents. */
  baselineSpendCents: number;
  travelNotice: boolean;
  knownDevices: string[];
  cardLast4: string;
}

export interface Transaction {
  id: string;
  customerId: string;
  amountCents: number;
  currency: string;
  merchant: string;
  city: string;
  region: string;
  country: string;
  device: string;
  status: "pending_review" | "flagged" | "approved" | "cleared";
  at: string;
}

export type CustomerResponseType =
  | "recognizes_transaction"
  | "denies_transaction"
  | "reported_impersonation_call"
  | "was_asked_for_code"
  | "shared_code"
  | "confirmed_reverse_auth"
  | "reverse_auth_mismatch"
  | "other";

export interface CustomerResponse {
  type: CustomerResponseType;
  note?: string;
  at: string;
  sessionId?: string;
}

export interface HumanReview {
  ticketId: string;
  priority: "standard" | "urgent";
  status: "queued";
  summary: string;
  requestedAt: string;
}

export interface GuardianCase {
  id: string;
  customerId: string;
  transactionId: string | null;
  channel: "sentinel_alert" | "phone_call" | "text_message" | "email" | "transaction" | "other";
  status: CaseStatus;
  summary: string;
  riskScore: number;
  riskHistory: { at: string; score: number; reason: string }[];
  cardLocked: boolean;
  transactionFlagged: boolean;
  reverseAuth: { phrase: string; issuedAt: string; verified: boolean } | null;
  humanReview: HumanReview | null;
  responses: CustomerResponse[];
  createdAt: string;
  updatedAt: string;
}

export type CaseEventType =
  | "case_created"
  | "detection"
  | "session_started"
  | "session_ended"
  | "tool_called"
  | "tool_replayed"
  | "tool_failed"
  | "reverse_auth_issued"
  | "reverse_auth_verified"
  | "risk_changed"
  | "card_locked"
  | "transaction_flagged"
  | "human_review_requested"
  | "customer_response"
  | "operator_action";

export interface CaseEvent {
  id: string;
  caseId: string;
  sessionId: string | null;
  type: CaseEventType;
  title: string;
  detail: string;
  actor: string;
  at: string;
  riskScore?: number;
}

export interface ToolInvocationRecord {
  id: string;
  sessionId: string;
  caseId: string;
  callId: string;
  tool: string;
  status: "ok" | "replayed" | "rejected" | "error";
  httpStatus: number;
  durationMs: number;
  argsSummary: string;
  resultSummary: string;
  at: string;
}

export type SessionState = "idle" | "connecting_upstream" | "starting" | "active" | "ending" | "ended" | "error";

export interface VoiceSessionRecord {
  id: string;
  role: AgentRole;
  caseId: string;
  mode: RuntimeMode;
  state: SessionState;
  toolsEnabled: boolean;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export type RuntimeMode = "mock" | "live" | "live-voice-only";

export function formatCad(cents: number): string {
  return `CAD $${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
