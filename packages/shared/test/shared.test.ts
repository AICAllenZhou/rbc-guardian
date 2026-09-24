import { describe, expect, it } from "vitest";
import {
  assessRisk,
  MAX_TOOLS_PER_CALL,
  redact,
  RESERVED_TOOL_NAMES,
  ROLE_TOOLS,
  TOOL_ARG_SCHEMAS,
  TOOL_NAMES,
  TOOL_SPECS,
  validateAlebexSchema,
  validateToolName,
  isToolAllowed,
  type CustomerProfile,
  type CustomerResponse,
  type Transaction,
} from "../src";

const profile: CustomerProfile = {
  id: "c",
  name: "Sarah Chen",
  homeCity: "Vancouver",
  homeRegion: "BC",
  homeCountry: "CA",
  baselineSpendCents: 8_500,
  travelNotice: false,
  knownDevices: ["iPhone"],
  cardLast4: "4417",
};
const txn: Transaction = { id: "t", customerId: "c", amountCents: 284_000, currency: "CAD", merchant: "Apple Store", city: "Miami", region: "FL", country: "US", device: "Unknown device", status: "pending_review", at: new Date().toISOString() };
const r = (type: CustomerResponse["type"]): CustomerResponse => ({ type, at: new Date().toISOString() });

describe("deterministic risk scoring", () => {
  it("scores the seeded scenario at 92 with transparent signals", () => {
    const a = assessRisk(profile, txn, []);
    expect(a.score).toBe(92);
    expect(a.band).toBe("critical");
    expect(a.signals.map((s) => s.id)).toEqual(["baseline", "new_location", "unknown_device", "large_amount", "no_travel_notice"]);
    expect(a.signals.reduce((n, s) => n + s.points, 0)).toBe(92);
  });

  it("rises to 96 on denial and caps at 99 after an OTP request", () => {
    expect(assessRisk(profile, txn, [r("denies_transaction")]).score).toBe(96);
    expect(assessRisk(profile, txn, [r("denies_transaction"), r("was_asked_for_code")]).score).toBe(99);
  });

  it("counts each signal once even if recorded twice", () => {
    expect(assessRisk(profile, txn, [r("denies_transaction"), r("denies_transaction")]).score).toBe(96);
  });

  it("drops transaction signals when the customer recognises the purchase", () => {
    const a = assessRisk(profile, txn, [r("recognizes_transaction")]);
    expect(a.score).toBe(10);
    expect(a.band).toBe("low");
  });

  it("travel notice and known device reduce the score", () => {
    const a = assessRisk({ ...profile, travelNotice: true, knownDevices: ["Unknown device"] }, txn, []);
    expect(a.score).toBe(62);
  });

  it("scores a TrustLine report without a transaction", () => {
    expect(assessRisk(profile, null, []).score).toBe(10);
    expect(assessRisk(profile, null, [r("reported_impersonation_call"), r("was_asked_for_code")]).score).toBe(65);
    expect(assessRisk(profile, null, [r("denies_transaction")]).score).toBe(10);
  });
});

describe("redaction", () => {
  it.each([
    ["my code is 482913", "my code is [code]"],
    ["card 4520 1234 5678 9012", "card [card number]"],
    ["email sarah.chen@example.com please", "email [email] please"],
    ["call me at 604-555-0199", "call me at [phone]"],
    ["it was four eight two one nine", "it was [code]"],
  ])("redacts %s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it.each(["CAD $2,840 at the Apple Store", "case GUARD-4821", "risk 92 out of 99", "card ending 4417 is locked", "listening on http://127.0.0.1:3001", "path /tools/1234"])("leaves %s readable where safe", (input) => {
    expect(redact(input)).toBe(input);
  });
});

describe("tool catalog", () => {
  it("every tool definition uses only the documented Alebex schema subset", () => {
    for (const name of TOOL_NAMES) {
      expect(validateAlebexSchema(TOOL_SPECS[name].parameters), name).toEqual([]);
      expect(JSON.stringify(TOOL_SPECS[name].parameters)).not.toMatch(/\$ref|\$defs|oneOf|anyOf|allOf|spoken_line/);
      expect(TOOL_SPECS[name].description.length).toBeLessThanOrEqual(1024);
      expect(validateToolName(name)).toBeNull();
      expect(RESERVED_TOOL_NAMES).not.toContain(name);
    }
  });

  it("schema validator catches forbidden constructs", () => {
    expect(validateAlebexSchema({ type: "object", properties: { a: { anyOf: [] } } })).not.toEqual([]);
    expect(validateAlebexSchema({ type: "object", properties: { spoken_line: { type: "string" } } })).not.toEqual([]);
    expect(validateAlebexSchema({ type: "object", properties: {}, required: ["x"] })).not.toEqual([]);
    expect(validateAlebexSchema({ type: "string" })).not.toEqual([]);
    expect(validateToolName("transfer_call")).not.toBeNull();
    expect(validateToolName("get_skill_x")).not.toBeNull();
    expect(validateToolName("9bad")).not.toBeNull();
  });

  it("JSON Schema required fields agree with the Zod validators", () => {
    for (const name of TOOL_NAMES) {
      const required = TOOL_SPECS[name].parameters.required ?? [];
      const empty = TOOL_ARG_SCHEMAS[name].safeParse({});
      expect(empty.success, name).toBe(required.length === 0);
    }
  });

  it("enforces least-privilege allowlists within the per-call limit", () => {
    for (const tools of Object.values(ROLE_TOOLS)) expect(tools.length).toBeLessThanOrEqual(MAX_TOOLS_PER_CALL);
    expect(isToolAllowed("trustline", "temporary_card_lock")).toBe(false);
    expect(isToolAllowed("trustline", "flag_suspicious_transaction")).toBe(false);
    expect(isToolAllowed("recovery", "issue_reverse_auth_phrase")).toBe(false);
    expect(isToolAllowed("sentinel", "temporary_card_lock")).toBe(true);
    expect(isToolAllowed("sentinel", "create_guardian_case")).toBe(false);
    expect(isToolAllowed("sentinel", "not_a_tool")).toBe(false);
  });

  it("validates tool arguments", () => {
    expect(TOOL_ARG_SCHEMAS.temporary_card_lock.safeParse({ customer_confirmed: true, reason: "x" }).success).toBe(true);
    expect(TOOL_ARG_SCHEMAS.temporary_card_lock.safeParse({ customer_confirmed: "yes", reason: "x" }).success).toBe(false);
    expect(TOOL_ARG_SCHEMAS.record_customer_response.safeParse({ response_type: "made_up" }).success).toBe(false);
    expect(TOOL_ARG_SCHEMAS.get_recent_transactions.safeParse({ limit: 50 }).success).toBe(false);
  });
});
