/**
 * Guardian Custom Tool catalog. One source of truth for:
 *  - the JSON Schema sent to Alebex in `start_call.customTools` (documented subset only:
 *    type/properties/required/description/enum/items — no $ref/oneOf/anyOf/allOf),
 *  - the Zod validator our endpoint applies to `arguments`,
 *  - per-role least-privilege allowlists.
 */
import { z } from "zod";
import type { AgentRole } from "./domain";

export const TOOL_NAMES = [
  "get_guardian_case",
  "get_recent_transactions",
  "issue_reverse_auth_phrase",
  "record_customer_response",
  "create_guardian_case",
  "temporary_card_lock",
  "flag_suspicious_transaction",
  "request_human_review",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const RESPONSE_TYPES = [
  "recognizes_transaction",
  "denies_transaction",
  "reported_impersonation_call",
  "was_asked_for_code",
  "shared_code",
  "confirmed_reverse_auth",
  "reverse_auth_mismatch",
  "other",
] as const;

const note = z.string().max(500).optional();

export const TOOL_ARG_SCHEMAS = {
  get_guardian_case: z.object({}),
  get_recent_transactions: z.object({ limit: z.number().int().min(1).max(10).optional() }),
  issue_reverse_auth_phrase: z.object({}),
  record_customer_response: z.object({ response_type: z.enum(RESPONSE_TYPES), note }),
  create_guardian_case: z
    .object({
      contact_channel: z.enum(["phone_call", "text_message", "email", "transaction", "other"]),
      summary: z.string().min(1).max(500),
      claimed_organization: z.string().max(120).optional(),
      requested_sensitive_info: z.boolean().optional(),
    })
    ,
  temporary_card_lock: z.object({ customer_confirmed: z.boolean(), reason: z.string().min(1).max(300) }),
  flag_suspicious_transaction: z.object({ transaction_id: z.string().max(64).optional(), reason: z.string().min(1).max(300) }),
  request_human_review: z.object({ priority: z.enum(["standard", "urgent"]), summary: z.string().min(1).max(500) }),
} satisfies Record<ToolName, z.ZodType>;

export type ToolArgs<T extends ToolName> = z.infer<(typeof TOOL_ARG_SCHEMAS)[T]>;

export interface ToolSpec {
  name: ToolName;
  description: string;
  sideEffect: boolean;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  get_guardian_case: {
    name: "get_guardian_case",
    sideEffect: false,
    description:
      "Read the current Guardian fraud case for this call: case ID, status, risk score, the flagged transaction, whether the card is locked and whether human review was requested. Call it at the start of the conversation and whenever you need to state the case status. Never guess case details instead of calling this. This is sandbox demo data.",
    parameters: { type: "object", properties: {} },
  },
  get_recent_transactions: {
    name: "get_recent_transactions",
    sideEffect: false,
    description:
      "List the customer's most recent mock card transactions with merchant, amount, city and device. Call it after reverse authentication is confirmed, when you need to describe the suspicious purchase or the customer asks what else is on the card. Do not call it before the customer has confirmed the reverse-authentication phrase.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", description: "How many transactions to list, 1 to 10. Default 3." } },
    },
  },
  issue_reverse_auth_phrase: {
    name: "issue_reverse_auth_phrase",
    sideEffect: true,
    description:
      "Issue a one-time reverse-authentication phrase that also appears in the customer's Guardian app, so the bank proves its identity to the customer. Call it near the start, right after your safety disclosure and before discussing any case details. Read the phrase aloud and ask the customer whether it matches what their screen shows. Calling it again in the same call returns the same phrase.",
    parameters: { type: "object", properties: {} },
  },
  record_customer_response: {
    name: "record_customer_response",
    sideEffect: true,
    description:
      "Record what the customer just told you so the fraud case and risk score update. Call it each time the customer: confirms or rejects the reverse-authentication phrase, says they do or do not recognise a transaction, reports a call or message pretending to be the bank, says someone asked them for a code, or says they shared a code. One call per distinct fact.",
    parameters: {
      type: "object",
      properties: {
        response_type: {
          type: "string",
          enum: [...RESPONSE_TYPES],
          description:
            "confirmed_reverse_auth: phrase matches. reverse_auth_mismatch: it does not. recognizes_transaction / denies_transaction: about the flagged purchase. reported_impersonation_call: a call, text or email claimed to be the bank. was_asked_for_code: someone requested a verification code, PIN or password. shared_code: the customer gave a code away.",
        },
        note: { type: "string", description: "Short, non-sensitive summary in the customer's words. Never include codes, PINs, passwords or card numbers." },
      },
      required: ["response_type"],
    },
  },
  create_guardian_case: {
    name: "create_guardian_case",
    sideEffect: true,
    description:
      "Open a Guardian case for a suspicious contact the customer is reporting (a call, text, email or transaction). Call it once you understand what happened, after asking only non-sensitive questions. Do not call it for general questions that are not a report.",
    parameters: {
      type: "object",
      properties: {
        contact_channel: { type: "string", enum: ["phone_call", "text_message", "email", "transaction", "other"], description: "How the suspicious contact reached the customer." },
        summary: { type: "string", description: "One or two sentences describing what happened, without codes, passwords or card numbers." },
        claimed_organization: { type: "string", description: "Who the contact claimed to be, for example 'RBC fraud department'." },
        requested_sensitive_info: { type: "boolean", description: "True if the contact asked for a password, PIN, one-time code or card number." },
      },
      required: ["contact_channel", "summary"],
    },
  },
  temporary_card_lock: {
    name: "temporary_card_lock",
    sideEffect: true,
    description:
      "Place a temporary lock on the customer's mock card. Only call it after you have asked 'Would you like me to place a temporary lock on your card?' and the customer has clearly said yes. Set customer_confirmed to true only in that case. This is a reversible sandbox action; no real card is affected.",
    parameters: {
      type: "object",
      properties: {
        customer_confirmed: { type: "boolean", description: "True only if the customer explicitly approved the lock in this conversation." },
        reason: { type: "string", description: "Why the lock is being placed, in plain words." },
      },
      required: ["customer_confirmed", "reason"],
    },
  },
  flag_suspicious_transaction: {
    name: "flag_suspicious_transaction",
    sideEffect: true,
    description:
      "Flag the suspicious mock transaction on this case as fraud so it is held for investigation. Call it after the customer says they do not recognise the transaction. Do not call it if the customer says they made the purchase.",
    parameters: {
      type: "object",
      properties: {
        transaction_id: { type: "string", description: "Transaction ID from get_guardian_case. Leave empty to flag the case's transaction." },
        reason: { type: "string", description: "Why it is suspicious, in plain words." },
      },
      required: ["reason"],
    },
  },
  request_human_review: {
    name: "request_human_review",
    sideEffect: true,
    description:
      "Queue this case for a human fraud specialist. Call it when the risk is high, when the customer shared a code, when the customer asks to speak to a person, or before ending a call where protective action was taken. Use priority urgent when a code was shared or a transaction was denied.",
    parameters: {
      type: "object",
      properties: {
        priority: { type: "string", enum: ["standard", "urgent"], description: "urgent if money or credentials may be at risk right now." },
        summary: { type: "string", description: "Two sentences a specialist can act on, without sensitive values." },
      },
      required: ["priority", "summary"],
    },
  },
};

/** Least-privilege allowlists: each agent only receives the tools its job needs. */
export const ROLE_TOOLS: Record<AgentRole, readonly ToolName[]> = {
  trustline: ["get_guardian_case", "issue_reverse_auth_phrase", "record_customer_response", "create_guardian_case", "request_human_review"],
  sentinel: [
    "get_guardian_case",
    "get_recent_transactions",
    "issue_reverse_auth_phrase",
    "record_customer_response",
    "temporary_card_lock",
    "flag_suspicious_transaction",
    "request_human_review",
  ],
  recovery: ["get_guardian_case", "record_customer_response", "request_human_review"],
};

export const MAX_TOOLS_PER_CALL = 8;

export const RESERVED_TOOL_NAMES = [
  "end_call",
  "transfer_call",
  "leave_voicemail",
  "mark_call_screening",
  "unmark_call_screening",
  "list_available_slots",
  "book_appointment",
  "cancel_appointment",
  "reschedule_appointment",
  "get_appointments",
];

export function isToolAllowed(role: AgentRole, tool: string): tool is ToolName {
  return (ROLE_TOOLS[role] as readonly string[]).includes(tool);
}

const ALLOWED_KEYWORDS = new Set(["type", "properties", "required", "description", "enum", "items"]);
const ALLOWED_TYPES = new Set(["object", "string", "integer", "number", "boolean", "array"]);

/** Validate a tool's JSON Schema against the documented Alebex subset. Returns a list of problems. */
export function validateAlebexSchema(schema: unknown, path = "parameters", depth = 0): string[] {
  const problems: string[] = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${path}: must be an object`];
  const s = schema as Record<string, unknown>;
  for (const key of Object.keys(s)) if (!ALLOWED_KEYWORDS.has(key)) problems.push(`${path}: keyword '${key}' is not in the Alebex subset`);
  if (typeof s.type !== "string" || !ALLOWED_TYPES.has(s.type)) problems.push(`${path}: invalid type`);
  if (depth === 0 && s.type !== "object") problems.push(`${path}: root must be type object`);
  if (s.type === "object") {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    if (depth === 0 && s.properties === undefined) problems.push(`${path}: root object must declare properties`);
    if (Object.keys(props).length > 20) problems.push(`${path}: more than 20 properties`);
    if (depth >= 3) problems.push(`${path}: nested deeper than 3 levels`);
    for (const [k, v] of Object.entries(props)) {
      if (k === "spoken_line") problems.push(`${path}.properties.spoken_line: reserved by the engine`);
      problems.push(...validateAlebexSchema(v, `${path}.properties.${k}`, depth + 1));
    }
    if (s.required !== undefined) {
      if (!Array.isArray(s.required)) problems.push(`${path}: required must be an array`);
      else for (const r of s.required) if (!(r in props)) problems.push(`${path}: required names missing property '${String(r)}'`);
    }
  }
  if (s.type === "array" && s.items !== undefined) problems.push(...validateAlebexSchema(s.items, `${path}.items`, depth + 1).filter((p) => !p.includes("root")));
  return problems;
}

export function validateToolName(name: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) return "name must be 1-64 chars, letters/digits/_/-, starting with a letter";
  if (RESERVED_TOOL_NAMES.includes(name) || name.startsWith("get_skill_")) return "name is reserved by the engine";
  return null;
}
