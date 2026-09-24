import type {
  AgentRole,
  CaseEvent,
  CreateSessionResponse,
  CustomerProfile,
  GuardianCase,
  ReadinessReport,
  RiskAssessment,
  ToolInvocationRecord,
  Transaction,
  VoiceSessionRecord,
} from "@guardian/shared";

/** The gateway's public origin. Not a secret: the Alebex token lives only on the gateway. */
export const GATEWAY_URL = (process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3001").replace(/\/+$/, "");
export const GATEWAY_WS_URL = GATEWAY_URL.replace(/^http/, "ws");
export const TICKET_SUBPROTOCOL_PREFIX = "guardian.ticket.";

export interface CaseView {
  case: GuardianCase;
  customer: CustomerProfile | null;
  transaction: Transaction | null;
  assessment: RiskAssessment;
  events: CaseEvent[];
  tools: ToolInvocationRecord[];
  sessions: VoiceSessionRecord[];
  messages: { id: string; sessionId: string; role: "user" | "agent"; text: string; at: string }[];
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  } catch {
    throw new GatewayError(0, "The Guardian gateway is not reachable. Start it with `pnpm dev` (it runs on port 3001).");
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new GatewayError(res.status, body.error ?? `Gateway returned ${res.status}.`);
  return body;
}

export const api = {
  readiness: () => request<ReadinessReport>("/api/readiness"),
  reset: () => request<{ ok: true }>("/api/demo/reset", { method: "POST", body: "{}" }),
  detect: () => request<{ case: GuardianCase }>("/api/demo/detect", { method: "POST", body: "{}" }),
  cases: () => request<{ cases: GuardianCase[] }>("/api/cases"),
  caseView: (id: string) => request<CaseView>(`/api/cases/${encodeURIComponent(id)}`),
  createSession: (role: AgentRole, caseId?: string) => request<CreateSessionResponse>("/api/sessions", { method: "POST", body: JSON.stringify(caseId ? { role, caseId } : { role }) }),
  operator: (caseId: string, tool: string, args: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/api/cases/${encodeURIComponent(caseId)}/operator`, { method: "POST", body: JSON.stringify({ tool, arguments: args }) }),
  summaryUrl: (id: string) => `${GATEWAY_URL}/api/cases/${encodeURIComponent(id)}/summary`,
  eventsUrl: (caseId: string) => `${GATEWAY_URL}/api/events?caseId=${encodeURIComponent(caseId)}`,
};
