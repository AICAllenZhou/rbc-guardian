import type { CustomerProfile, Transaction } from "@guardian/shared";

export const SEED_CASE_ID = "GUARD-4821";
export const SEED_CUSTOMER_ID = "cust-sarah-chen";
export const SEED_TXN_ID = "TXN-7Q2M";

export const SEED_CUSTOMER: CustomerProfile = {
  id: SEED_CUSTOMER_ID,
  name: "Sarah Chen",
  homeCity: "Vancouver",
  homeRegion: "BC",
  homeCountry: "CA",
  baselineSpendCents: 8_500,
  travelNotice: false,
  knownDevices: ["iPhone 15 (Sarah)", "MacBook Air (Sarah)"],
  cardLast4: "4417",
};

function minutesAgo(now: number, m: number): string {
  return new Date(now - m * 60_000).toISOString();
}

export function seedTransactions(now = Date.now()): Transaction[] {
  const base = { customerId: SEED_CUSTOMER_ID, currency: "CAD", status: "cleared" as const };
  return [
    { ...base, id: SEED_TXN_ID, amountCents: 284_000, merchant: "Apple Store", city: "Miami", region: "FL", country: "US", device: "Unknown device", status: "pending_review", at: minutesAgo(now, 4) },
    { ...base, id: "TXN-5K1P", amountCents: 1_245, merchant: "Blenz Coffee", city: "Vancouver", region: "BC", country: "CA", device: "iPhone 15 (Sarah)", at: minutesAgo(now, 190) },
    { ...base, id: "TXN-3H8D", amountCents: 8_730, merchant: "Save-On-Foods", city: "Vancouver", region: "BC", country: "CA", device: "iPhone 15 (Sarah)", at: minutesAgo(now, 1_460) },
    { ...base, id: "TXN-2B6N", amountCents: 4_599, merchant: "Compass Card Top-up", city: "Vancouver", region: "BC", country: "CA", device: "iPhone 15 (Sarah)", at: minutesAgo(now, 2_900) },
  ];
}

const COLOURS = ["BLUE", "GOLD", "SILVER", "CEDAR", "AMBER", "COBALT", "IVORY", "COPPER", "NORTHERN", "HARBOUR"];
const NOUNS = ["MAPLE", "HERON", "LANTERN", "GLACIER", "ORCHARD", "COMPASS", "SPRUCE", "BEACON", "RIVER", "SUMMIT"];

/** A two-word phrase that is easy to read aloud and to compare on screen. */
export function makeReversePhrase(random: () => number = Math.random): string {
  const c = COLOURS[Math.floor(random() * COLOURS.length)] ?? "BLUE";
  const n = NOUNS[Math.floor(random() * NOUNS.length)] ?? "MAPLE";
  return `${c} ${n}`;
}
