# Security and privacy

> Hackathon concept demo. Not an official RBC product. No real banking action is performed. All data is sandbox data.

## Secrets

| Secret | Where it lives | Never appears in |
|---|---|---|
| Alebex key (`ALEBEX_API_KEY`, aliases `ALEBEX_VOICE_TOKEN`, `ALEB_API_KEY`) | Gateway process env, read once in `apps/gateway/src/env.ts` | Browser code or traffic, logs, probe output, reports, git |
| `TOOL_SIGNING_SECRET` | Gateway process env | Tool headers (only derived HMAC tokens are sent), browser, logs |
| Per-session tool token | `customTools[].headers.Authorization`, sent to Alebex only | Browser traffic (verified by e2e and the live smoke test) |
| Browser call ticket | Returned to the browser that created the session; sent as a WebSocket subprotocol | URLs, logs |

- **No `NEXT_PUBLIC_` secret exists.** The browser's only build-time value is the gateway URL.
- **The token is used in exactly one place**: the upstream subprotocol `alebex.token.<key>`, opened by the gateway. The probe replaces the token with `[token]` before printing anything.
- **`pnpm secret-scan`** checks every file git would track, plus the built client bundle (`apps/web/.next/static`), for Alebex/Twilio/Stripe-style tokens, token-bearing subprotocol strings, bearer literals, private keys, and the literal values of local `.env` secrets. It prints only file and rule names, and it fails if `.env` is tracked. It ran clean before every commit.

## Tool credentials

- **Token format.** Each call gets its own token: `base64url({typ:"tool", sid, role, tools, exp}).HMAC-SHA256`. It expires 5 minutes after the session's maximum length.
- **Checks on every tool request** (`apps/gateway/src/tools/handlers.ts`):
  - signature, using a constant-time compare;
  - expiry and token type;
  - that the `X-Guardian-Session` header, the `?s=` URL parameter and the token's `sid` all match;
  - that the tool is in both the token's list and the role's allowlist, so a forged or mis-scoped token cannot let TrustLine lock a card;
  - that the session exists, has the same role, and is still live, so there are no side effects after a call ends;
  - that the envelope `tool` matches the path;
  - the arguments, against Zod.
- **Idempotency.** Every side-effecting tool is keyed on `HMAC(call.id, tool, normalised arguments)`. Free-text fields (reason, summary, note) are excluded, so a rephrased duplicate still dedupes. Only successful results are pinned; a refused lock without consent can be retried properly once consent is given. Duplicates are audited as `tool_replayed`.
- **Consent.** `temporary_card_lock` refuses with 409 unless `customer_confirmed` is `true`.
- **Response size.** Responses are capped at 2 KB and always include demo wording.

## Browser socket

- The ticket is single-use, lasts 60 s, and is bound to the session; reuse and stale reconnects are refused with `4401`.
- An `Origin` allowlist accepts `APP_ORIGIN` and `localhost`/`127.0.0.1` during development.
- One socket per session, one active call per tab (enforced in the client), and at most 3 concurrent sessions per gateway.
- Limits: 32 kB audio frames, 80 messages/s, 10-minute calls, 64 kB WebSocket payloads, 64 kB HTTP bodies.

## Privacy

- **Raw audio is never written to disk.** The gateway only forwards it; the probe's synthetic fixture lives in a temp directory and is deleted.
- **Transcripts are redacted before storage** (`packages/shared/src/redact.ts`): 4–8-digit codes, spoken digit sequences, card-like numbers, emails and phone numbers. Amounts (`$2,840`), case IDs (`GUARD-4821`), "card ending 4417", ports and paths stay readable. The live call panel shows redacted text by default, with an explicit "Show unredacted" toggle for the current session only.
- **Logs** are structured JSON through `scrub()`. It masks secret-named fields, token-shaped strings anywhere, and redaction patterns. Callers log lengths, types and IDs, never transcript text.
- **The probe** records frame shapes and enum values only (`docs/probe/*.json`).

## Known gaps (acceptable for a local P1 demo; fix before anything is shared)

| Gap | Risk | P2 fix |
|---|---|---|
| `/api/*` (demo reset, detect, operator actions, case views, SSE) has no authentication | Anyone who can reach the gateway can read or modify sandbox cases | The gateway binds to `127.0.0.1` by default. When tunnelling, only expose `/tools/*` (a Cloudflare tunnel ingress rule, or a path-filtering proxy). Add session auth before any shared deployment |
| SSE `*` stream shows all sandbox cases | Same as above | Scope streams to an authenticated viewer |
| `TOOL_SIGNING_SECRET` falls back to a random per-process value | Tool tokens stop verifying after a restart mid-call | Set it in `.env` (the current `.env` does) |
| No CSP header on the web app | XSS impact is larger | Add a strict CSP; the app loads no third-party scripts |

## Dependency audit

`pnpm audit` found 3 dev-only advisories: Vitest path traversal (moderate) and esbuild dev-server file read (low). Vitest was upgraded to 4.1.x and esbuild overridden to ≥ 0.28.1. The audit now reports **no known vulnerabilities**.
