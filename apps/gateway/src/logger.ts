/**
 * Structured JSON logs with redaction. Keys that can carry secrets are masked,
 * token-shaped strings are masked wherever they appear, and transcript text is
 * never passed to the logger by callers (only lengths and types).
 */
import { redact } from "@guardian/shared";

const SECRET_KEYS = /token|secret|authorization|api[_-]?key|password|ticket|cookie|subprotocol/i;
const TOKEN_LIKE = /\b(?:wt|sk|alebex)_[A-Za-z0-9_-]{8,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+\b|\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{30,}\b/g;

export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redact(value.replace(TOKEN_LIKE, "[redacted-token]"));
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(opts: { silent?: boolean; sink?: (line: string) => void } = {}): Logger {
  const sink = opts.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const write = (level: string, event: string, fields?: Record<string, unknown>) => {
    if (opts.silent) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level, event, ...(scrub(fields ?? {}) as object) }));
  };
  return {
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
  };
}
