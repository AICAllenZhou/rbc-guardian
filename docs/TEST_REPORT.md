# Test report

Run on 2026-09-24 on macOS (Darwin 25.6), Node 25.8.1, pnpm 10.34.5, Chromium from Playwright.

## Quality gate

| Command | Result |
|---|---|
| `pnpm lint` | ✅ 0 problems (ESLint 9, typescript-eslint, react-hooks) |
| `pnpm typecheck` | ✅ 4 packages, strict mode |
| `pnpm test` | ✅ **95 passed** (7 files) |
| `pnpm test:integration` | ✅ **23 passed** |
| `pnpm test:e2e` | ✅ **6 passed**; stability run `--repeat-each=3`: **18/18** |
| `pnpm build` | ✅ packages, gateway bundle (tsup), Next.js production build |
| `pnpm secret-scan` | ✅ clean (tracked files, client bundle, and local secret values) |
| `pnpm audit` | ✅ no known vulnerabilities |
| `pnpm probe:alebex` | ✅ **live PASS** (full mode, real agent) |
| `pnpm smoke:live --role sentinel\|trustline\|recovery` | ✅ **live PASS × 3** |

## Unit (95)

| Area | Covered |
|---|---|
| Audio DSP | Float32 → PCM16 clamping and scaling; little-endian bytes; round-trip; resampling to **exactly** 16,000 samples/s from 8, 16, 22.05, 44.1, 48 and 96 kHz; identical output for any chunking; tone fidelity; 3,200-sample framing and remainder; MicEncoder → 6,400-byte frames; base64 |
| Protocol parser | Every live-confirmed frame; a non-default sample rate carried through; unconfirmed layouts and formats refused; verbatim mark objects; shape descriptor hides values |
| Playback | Ordered scheduling; mark released only after its audio; mark with an empty queue; multiple marks in order; `clear_audio` flushes audio and drops marks forever; adaptive jitter buffer growth and cap |
| Transcript | Partial snapshots replace (never append); shrinking partials; commit clears the draft; duplicate commits ignored |
| Risk | Seeded 92 with an exact signal breakdown; 96 on denial; 99 cap after a code request; each signal once; recognised purchase → 10; travel notice and known device; TrustLine scoring |
| Redaction | OTP, card, email, phone, spoken digits; amounts, case IDs, last-4, ports and paths preserved |
| Tools | Every schema within the Alebex subset (no `$ref/oneOf/anyOf/allOf`, no `spoken_line`); descriptions ≤ 1024; valid, non-reserved names; JSON Schema `required` agrees with Zod; per-role allowlists ≤ 8 |
| Gateway units | Env validation (mock default, live errors, token aliases, single-agent fallback, voice-only, https-only tool URL, bad mode); tool token and ticket verification (expired, tampered, foreign secret, wrong type); idempotency keys; `customTools` builder (no secrets, per-session headers); state-machine transitions; log scrubbing; phrase format |
| Tool service | Card lock applied **once** despite a duplicate call; lock refused without consent and not pinned; 92 → 96 → 99 with code redaction; one phrase per session; responses < 2 KB with demo wording; invalid args; foreign transaction; HTTP auth: missing or bad token, session mismatch (header and URL), role allowlist beats token scope, tool not in token, ended call, malformed envelope, path mismatch, dedupe on `call.id` |
| Components (RTL) | Risk meter a11y values; seal empty, unverified and verified states; timeline order, limit and empty state; protective actions state and screen-reader text |

## Integration (23): gateway ↔ mock Alebex over real sockets

Handshake with the token subprotocol; `start_call` exactly once with the role's agent ID and least-privilege tools; binary mic forwarding with exact byte counts; malformed frames dropped; agent audio delivered as binary; marks round-trip only when echoed (forged and repeated echoes blocked); user partials are snapshots; one message per utterance; `clear_audio` on barge-in with the interrupted mark never acknowledged; the full Sentinel workflow via HTTP Custom Tools (verify, deny, lock once, flag, urgent review, risk 99, clean end); Recovery continues the case; TrustLine opens a new case; bad and reused tickets (4401); foreign Origin (403); voice-only mode sends no tools; upgrade 403 → `upstream_auth` (4403); capacity refusals retried with backoff, then 4429; live-style `payload_unavailable` + 1011 → config error (4422); documented `invalid_config` + 1008 → 4422; dropped upstream → recoverable 4502; browser disappearing → `end_call` upstream; prompt finish on `call_ended`; SSE streaming with CORS; JSON export; readiness without secrets.

## End to end (6): Playwright, mock mode, fake microphone

1. Landing explains the concept, shows the disclaimer, architecture and three agents, then leads to `/demo`.
2. Sentinel: detection → risk 92 → simulated incoming call (labelled) → answer → disclosure → phrase on screen matches what Atlas says → confirm → transaction described → denial and code report → **risk 99** → consent → lock, flag and review done, **one** `card_locked` event, **one** ignored duplicate → no duplicate transcript lines, no stale drafts → end → Command Center shows risk history, "duplicate ignored", transcript, ended session → JSON export confirms one lock.
3. TrustLine: a new case (not GUARD-4821) → report → "Open" → not shared → "Human review requested" → end → Recovery with Nora picks up that case.
4. Diagnostics show readiness, and neither the signing secret nor any token appears in the HTML.
5. No token, signing secret, `alebex.token.`, or tool header in any WebSocket frame or gateway response the browser receives.
6. Phone width (390 px): no horizontal scroll on the landing or demo page; the phrase is visible under the call.

Screenshots: `docs/screenshots/01-landing-desktop.png` … `07-demo-mobile.png`.

## Live Alebex tests

| Test | Result | Evidence |
|---|---|---|
| Auth-only probe (before agent IDs existed) | ✅ Pass. Handshake OK; unknown agent → `payload_unavailable`, close 1011 | Recorded in `docs/ALEBEX_PROTOCOL_NOTES.md` |
| Full probe, Sentinel agent, synthetic phrase | ✅ Pass. `call_started`, 118 audio frames (pcm16, 24 kHz), 17 user transcript partials, 3 messages, `clear_audio` on barge-in, 2/2 marks echoed after simulated playback, `call_ended` 269 ms after `end_call` | `docs/probe/last-probe.json` |
| Gateway smoke, Sentinel | ✅ Pass. 15.3 s of agent audio, 2 marks acked, user 1 / agent 2 messages, close 1000, no secret leak | `docs/probe/live-smoke-sentinel.json` |
| Gateway smoke, TrustLine | ✅ Pass. 14.5 s of audio, 2 marks acked, close 1000 | `docs/probe/live-smoke-trustline.json` |
| Gateway smoke, Recovery | ✅ Pass. 41 s of audio, 1 mark acked, close 1000 | `docs/probe/live-smoke-recovery.json` |
| **Live Custom Tools** (read-only, reverse-auth, idempotent side effect) | ⏭️ **Skipped, not run.** No `PUBLIC_TOOL_BASE_URL`; no tunnel tool installed | See KNOWN_LIMITATIONS |
| Manual in-browser live call with a real microphone | ⏭️ **Not performed.** No human at the machine; the gateway path was exercised live by the Node client instead | — |
