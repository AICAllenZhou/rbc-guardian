/**
 * Deterministic, transparent fraud-risk scoring. No model involved: every point
 * is attributable to a named signal so the Command Center can show the breakdown.
 */
import type { CustomerProfile, CustomerResponse, Transaction } from "./domain";

export interface RiskSignal {
  id: string;
  label: string;
  points: number;
  source: "transaction" | "customer" | "baseline";
}

export interface RiskAssessment {
  score: number;
  signals: RiskSignal[];
  band: "low" | "elevated" | "high" | "critical";
}

export const RISK_CAP = 99;
const BASELINE = 10;

export function riskBand(score: number): RiskAssessment["band"] {
  if (score >= 90) return "critical";
  if (score >= 70) return "high";
  if (score >= 40) return "elevated";
  return "low";
}

export function transactionSignals(profile: CustomerProfile, txn: Transaction): RiskSignal[] {
  const s: RiskSignal[] = [];
  if (txn.country !== profile.homeCountry || txn.region !== profile.homeRegion) {
    s.push({ id: "new_location", label: `New location: ${txn.city}, ${txn.region} (home is ${profile.homeCity}, ${profile.homeRegion})`, points: 30, source: "transaction" });
  }
  if (!profile.knownDevices.includes(txn.device)) {
    s.push({ id: "unknown_device", label: "Purchase from an unrecognised device", points: 20, source: "transaction" });
  }
  if (txn.amountCents >= profile.baselineSpendCents * 3) {
    const multiple = Math.round(txn.amountCents / profile.baselineSpendCents);
    s.push({ id: "large_amount", label: `Amount is ~${multiple}× this customer's typical purchase`, points: 22, source: "transaction" });
  }
  if (!profile.travelNotice && txn.country !== profile.homeCountry) {
    s.push({ id: "no_travel_notice", label: "No travel notice on file", points: 10, source: "transaction" });
  }
  return s;
}

const RESPONSE_SIGNALS: Partial<Record<CustomerResponse["type"], Omit<RiskSignal, "source">>> = {
  denies_transaction: { id: "customer_denied", label: "Customer does not recognise the transaction", points: 4 },
  reported_impersonation_call: { id: "impersonation_call", label: "Customer reports a call impersonating the bank", points: 30 },
  was_asked_for_code: { id: "code_requested", label: "Caller asked the customer for a verification code", points: 25 },
  shared_code: { id: "code_shared", label: "Customer shared a verification code", points: 20 },
  reverse_auth_mismatch: { id: "reverse_auth_mismatch", label: "A caller could not prove it was the bank", points: 15 },
};

export function assessRisk(
  profile: CustomerProfile,
  txn: Transaction | null,
  responses: readonly CustomerResponse[],
): RiskAssessment {
  const signals: RiskSignal[] = [{ id: "baseline", label: "Baseline", points: BASELINE, source: "baseline" }];
  const recognised = responses.some((r) => r.type === "recognizes_transaction") && !responses.some((r) => r.type === "denies_transaction");
  if (txn && !recognised) signals.push(...transactionSignals(profile, txn));
  if (txn && recognised) {
    signals.push({ id: "customer_recognised", label: "Customer confirms they made this purchase", points: 0, source: "customer" });
  }
  const seen = new Set<string>();
  for (const r of responses) {
    const sig = RESPONSE_SIGNALS[r.type];
    if (!sig || seen.has(sig.id)) continue;
    if (sig.id === "customer_denied" && !txn) continue;
    seen.add(sig.id);
    signals.push({ ...sig, source: "customer" });
  }
  const raw = signals.reduce((sum, s) => sum + s.points, 0);
  const score = Math.max(0, Math.min(RISK_CAP, raw));
  return { score, signals, band: riskBand(score) };
}
