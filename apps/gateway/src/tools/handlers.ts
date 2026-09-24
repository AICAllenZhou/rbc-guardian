/**
 * Custom Tool endpoint logic. Alebex POSTs `{tool, arguments, call}` here
 * (AGENTS.md "What the engine sends your endpoint"). The engine does not retry
 * and is not idempotent, and the model may call a tool twice in a turn, so every
 * side-effecting tool is keyed on call.id + tool + normalised arguments.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AGENT_PERSONAS,
  formatCad,
  isToolAllowed,
  redact,
  TOOL_ARG_SCHEMAS,
  TOOL_NAMES,
  TOOL_SPECS,
  type AgentRole,
  type ToolArgs,
  type ToolName,
} from "@guardian/shared";
import { actorFor, CaseError, type CaseService } from "../cases";
import type { Store } from "../store";
import { idempotencyKey, verifyToolToken } from "../tokens";
import type { Logger } from "../logger";

export const ToolEnvelopeSchema = z.object({
  tool: z.string().max(64),
  arguments: z.record(z.string(), z.unknown()).default({}),
  call: z
    .object({ id: z.string().min(1).max(200), agentId: z.string().max(200).optional(), startedAt: z.string().max(64).optional() })
    .passthrough(),
});

export interface ToolResult {
  status: number;
  body: Record<string, unknown>;
}

const DEMO_NOTE = "Sandbox demo data. No real banking action was performed.";
const MAX_BODY_BYTES = 2_048;

export interface ToolContext {
  role: AgentRole | "operator";
  sessionId: string | null;
  caseId: string;
  callId: string;
}

export class ToolService {
  constructor(
    private readonly store: Store,
    private readonly cases: CaseService,
    private readonly signingSecret: string,
    private readonly log: Logger,
  ) {}

  /** Full HTTP path: authenticate, validate the envelope, then run. */
  async handleHttp(pathTool: string, headers: Record<string, string | string[] | undefined>, query: Record<string, unknown>, rawBody: unknown): Promise<ToolResult> {
    const started = Date.now();
    if (!(TOOL_NAMES as readonly string[]).includes(pathTool)) return { status: 404, body: { error: `Unknown tool ${pathTool}.` } };
    const tool = pathTool as ToolName;

    const auth = String(headers.authorization ?? "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const verified = verifyToolToken(this.signingSecret, token);
    if (!verified.ok) {
      this.log.warn("tool.auth_rejected", { tool, reason: verified.error });
      return { status: 401, body: { error: "Tool credential rejected." } };
    }
    const claims = verified.claims;
    const headerSid = String(headers["x-guardian-session"] ?? "");
    const querySid = typeof query.s === "string" ? query.s : "";
    if (headerSid !== claims.sid || (querySid && querySid !== claims.sid)) {
      this.log.warn("tool.session_mismatch", { tool, sessionId: claims.sid });
      return { status: 401, body: { error: "Tool credential does not match this session." } };
    }
    if (!claims.tools.includes(tool) || !isToolAllowed(claims.role, tool)) {
      this.log.warn("tool.not_allowed", { tool, role: claims.role, sessionId: claims.sid });
      return { status: 403, body: { error: `${AGENT_PERSONAS[claims.role].name} is not permitted to use ${tool}.` } };
    }
    const session = this.store.getSession(claims.sid);
    if (!session || session.role !== claims.role) return { status: 404, body: { error: "Voice session not found." } };
    if (!["starting", "active", "ending"].includes(session.state)) {
      return { status: 409, body: { error: "This voice session has ended; the action was not performed." } };
    }

    const env = ToolEnvelopeSchema.safeParse(rawBody);
    if (!env.success) return { status: 400, body: { error: "Malformed tool request envelope." } };
    if (env.data.tool !== tool) return { status: 400, body: { error: `Envelope names ${env.data.tool} but was sent to ${tool}.` } };

    const result = await this.run(tool, env.data.arguments, { role: claims.role, sessionId: session.id, caseId: session.caseId, callId: env.data.call.id });
    this.log.info("tool.completed", { tool, sessionId: session.id, role: claims.role, status: result.status, latencyMs: Date.now() - started });
    return result;
  }

  /** Validate arguments, apply idempotency, execute, audit. Used by HTTP, the mock engine and operator actions. */
  async run(tool: ToolName, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    const parsed = TOOL_ARG_SCHEMAS[tool].safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const result = { status: 400, body: { error: `Invalid arguments for ${tool}: ${issue ? `${issue.path.join(".") || "arguments"} ${issue.message}` : "invalid"}.` } };
      this.audit(tool, ctx, rawArgs, result, "rejected", started);
      return result;
    }
    const args = parsed.data;
    const spec = TOOL_SPECS[tool];
    const key = spec.sideEffect ? idempotencyKey(ctx.callId, tool, normaliseForIdempotency(tool, args)) : null;
    if (key) {
      const prior = this.store.getIdempotent(key);
      if (prior) {
        const result = { status: prior.status, body: { ...(prior.body as Record<string, unknown>), replayed: true } };
        this.audit(tool, ctx, args, result, "replayed", started);
        const c = this.store.getCase(ctx.caseId);
        if (c) this.cases.event(c, ctx.sessionId, "tool_replayed", `Duplicate ${tool} call ignored`, "Returned the first result; the action was not applied twice.", this.actor(ctx));
        return result;
      }
    }

    let result: ToolResult;
    try {
      result = { status: 200, body: this.execute(tool, args as never, ctx) };
    } catch (err) {
      const status = err instanceof CaseError ? err.status : 500;
      const message = err instanceof CaseError ? err.message : "Internal error in the Guardian sandbox.";
      if (!(err instanceof CaseError)) this.log.error("tool.exception", { tool, sessionId: ctx.sessionId, error: String(err) });
      result = { status, body: { error: message } };
    }
    result.body = capSize(result.body);
    // Only successful side effects are pinned; a refused call (e.g. lock without consent) can be retried properly.
    if (key && result.status === 200) this.store.putIdempotent(key, tool, result.status, result.body);
    this.audit(tool, ctx, args, result, result.status === 200 ? "ok" : result.status >= 500 ? "error" : "rejected", started);
    return result;
  }

  private actor(ctx: ToolContext): string {
    return actorFor(ctx.role);
  }

  private execute<T extends ToolName>(tool: T, args: ToolArgs<T>, ctx: ToolContext): Record<string, unknown> {
    const actor = this.actor(ctx);
    const sid = ctx.sessionId;
    switch (tool) {
      case "get_guardian_case": {
        const v = this.cases.view(ctx.caseId);
        const t = v.transaction;
        return {
          caseId: v.case.id,
          status: v.case.status.replace("_", " "),
          riskScore: `${v.case.riskScore} out of 99 (${v.assessment.band})`,
          customerFirstName: v.customer?.name.split(" ")[0] ?? "the customer",
          summary: v.case.summary,
          ...(t ? { transaction: { id: t.id, amount: formatCad(t.amountCents), merchant: t.merchant, location: `${t.city}, ${t.region}`, device: t.device, status: t.status.replace("_", " ") } } : { transaction: "none on this case" }),
          cardLocked: v.case.cardLocked ? "yes, temporarily (mock)" : "no",
          transactionFlagged: v.case.transactionFlagged ? "yes" : "no",
          reverseAuthentication: v.case.reverseAuth ? (v.case.reverseAuth.verified ? "confirmed by customer" : "issued, not yet confirmed") : "not issued",
          humanReview: v.case.humanReview ? `requested, ticket ${v.case.humanReview.ticketId}, ${v.case.humanReview.priority}` : "not requested",
          note: DEMO_NOTE,
        };
      }
      case "get_recent_transactions": {
        const c = this.cases.require(ctx.caseId);
        const limit = (args as ToolArgs<"get_recent_transactions">).limit ?? 3;
        const list = this.store.listTransactions(c.customerId, limit);
        return {
          transactions: list.map((t) => ({
            id: t.id,
            amount: formatCad(t.amountCents),
            merchant: t.merchant,
            location: `${t.city}, ${t.region}`,
            device: t.device,
            when: humanAgo(t.at),
            flagged: t.id === c.transactionId ? "this is the suspicious one" : "normal",
          })),
          note: DEMO_NOTE,
        };
      }
      case "issue_reverse_auth_phrase": {
        const { phrase, reused } = this.cases.issueReverseAuth(ctx.caseId, sid, actor);
        return {
          phrase,
          instruction: `Read the phrase aloud exactly: "${phrase}". Ask the customer whether their Guardian app shows the same two words. If it does not match, tell them to hang up and call the number on the back of their card.`,
          reused,
          note: DEMO_NOTE,
        };
      }
      case "record_customer_response": {
        const a = args as ToolArgs<"record_customer_response">;
        const { assessment, changed } = this.cases.recordResponse(ctx.caseId, a.response_type, a.note, sid, actor);
        return {
          recorded: a.response_type.replaceAll("_", " "),
          riskScore: `${assessment.score} out of 99 (${assessment.band})`,
          riskChanged: changed,
          ...(a.response_type === "reverse_auth_mismatch" ? { guidance: "Do not continue. Tell the customer to end this call and phone the number on the back of their card." } : {}),
          note: DEMO_NOTE,
        };
      }
      case "create_guardian_case": {
        const a = args as ToolArgs<"create_guardian_case">;
        const c = this.cases.openReportedCase(ctx.caseId, a, sid, actor);
        return { caseId: c.id, status: c.status, riskScore: `${c.riskScore} out of 99`, note: DEMO_NOTE };
      }
      case "temporary_card_lock": {
        const a = args as ToolArgs<"temporary_card_lock">;
        if (!a.customer_confirmed) throw new CaseError(409, "Not locked: ask the customer for explicit permission first, then call again with customer_confirmed true.");
        const { alreadyLocked } = this.cases.lockCard(ctx.caseId, a.reason, sid, actor);
        return { locked: true, alreadyLocked, cardEnding: "4417", reversible: "yes, the customer can unlock it later", note: DEMO_NOTE };
      }
      case "flag_suspicious_transaction": {
        const a = args as ToolArgs<"flag_suspicious_transaction">;
        const { alreadyFlagged, transaction } = this.cases.flagTransaction(ctx.caseId, a.transaction_id, a.reason, sid, actor);
        return { flagged: true, alreadyFlagged, transaction: `${formatCad(transaction.amountCents)} at ${transaction.merchant}, ${transaction.city}`, next: "Held for investigation by the mock fraud team.", note: DEMO_NOTE };
      }
      case "request_human_review": {
        const a = args as ToolArgs<"request_human_review">;
        const { already, case: c } = this.cases.requestReview(ctx.caseId, a.priority, a.summary, sid, actor);
        return { queued: true, alreadyQueued: already, ticket: c.humanReview?.ticketId, priority: c.humanReview?.priority, expectedContact: "A specialist would follow up in the Guardian app. Demo only.", note: DEMO_NOTE };
      }
      default:
        throw new CaseError(404, `Unknown tool ${String(tool)}`);
    }
  }

  private audit(tool: ToolName, ctx: ToolContext, args: unknown, result: ToolResult, status: "ok" | "replayed" | "rejected" | "error", started: number): void {
    const c = this.store.getCase(ctx.caseId);
    this.store.addToolInvocation({
      id: randomUUID(),
      sessionId: ctx.sessionId ?? "operator",
      caseId: ctx.caseId,
      callId: ctx.callId,
      tool,
      status,
      httpStatus: result.status,
      durationMs: Date.now() - started,
      argsSummary: redact(JSON.stringify(args ?? {})).slice(0, 300),
      resultSummary: redact(JSON.stringify(result.body)).slice(0, 400),
      at: new Date().toISOString(),
    });
    if (c && status !== "replayed") {
      const title = status === "ok" ? `Tool: ${tool}` : `Tool refused: ${tool}`;
      const detail = status === "ok" ? summariseArgs(args) : String(result.body.error ?? "");
      this.cases.event(c, ctx.sessionId, status === "ok" ? "tool_called" : "tool_failed", title, detail, this.actor(ctx));
    }
  }
}

/** Free-text fields (reason, summary, note) are excluded so a rephrased duplicate still dedupes. */
export function normaliseForIdempotency(tool: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case "record_customer_response":
      return { response_type: args.response_type };
    case "create_guardian_case":
      return { contact_channel: args.contact_channel };
    case "flag_suspicious_transaction":
      return {};
    case "temporary_card_lock":
      return { customer_confirmed: args.customer_confirmed };
    default:
      return {};
  }
}

function summariseArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const entries = Object.entries(args as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== "");
  return redact(entries.map(([k, v]) => `${k.replaceAll("_", " ")}: ${String(v)}`).join("; ")).slice(0, 240);
}

function humanAgo(iso: string): string {
  const min = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 60) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}

function capSize(body: Record<string, unknown>): Record<string, unknown> {
  const s = JSON.stringify(body);
  if (Buffer.byteLength(s) <= MAX_BODY_BYTES) return body;
  return { summary: s.slice(0, MAX_BODY_BYTES - 200), truncated: true, note: DEMO_NOTE };
}
