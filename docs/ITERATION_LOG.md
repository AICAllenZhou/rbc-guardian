# Iteration log

Five passes, recorded as they happened on 2026-09-23 and 24. Each entry lists findings, changes, verification and remaining risk.

## Pass 1: vertical slice

**Built:** workspace; `alebex-protocol` (PCM16, resampler, framer, parser, playback timeline, transcript store); `shared` (tools, risk, redaction, wire); gateway (env, tokens, SQLite store, case service, tool service, voice session state machine, session manager, SSE, mock engine); seeded GUARD-4821; Sentinel flow end to end against the mock engine.

**Findings and fixes**
- **Resampler lost a sample when upsampling**, and float step accumulation could drift at the boundary (8 kHz → 16 kHz gave 15,999 samples per second). Rewritten with exact integer position arithmetic and a one-sample delay, so N input samples yield exactly `floor(N·out/in)` for every chunking.
- **A framer test had wrong arithmetic** (expected a remainder of 300; the correct value is 100). Fixed the test.
- **Mock channel parsing** classified "someone *called* … a code from a *text*" as a text message. Phone-call wording now takes priority.
- **Shutdown race:** sessions finishing after `store.close()` threw "database is not open". Added `SessionManager.drain()`; shutdown and demo reset now end calls, wait for them, and only then close the store.

**Verified:** `pnpm test` (85), `pnpm test:integration` (21), typecheck, lint.
**Remaining risk:** frame layouts for audio, mark and transcript were still assumptions.

## Pass 2: protocol and reliability

**Findings and fixes**
- **Auth-only live probe** (no agent IDs yet): handshake accepted and the subprotocol echoed. An unknown agent returns `error{code:"payload_unavailable"}` then close **1011**, which is not the documented `invalid_config`/1008. The gateway previously classified this as a recoverable "connection dropped". Any error frame followed by a close is now a non-recoverable configuration error (4422, "check the agent ID"), and the mock mirrors the live behaviour.
- **Full live probe**, once agent IDs were added to `.env`: confirmed `audio {data, format:"pcm16", sample_rate:24000}` as JSON (never binary), `mark {name}`, user-only `transcript {role, text, is_final}`, `conversation_message {role:"assistant"|"user", content, timestamp}`, `clear_audio` on barge-in, `call_started`, `call_ended`. The adapter was **narrowed to exactly these shapes**, as the spec requires; the earlier tolerant variants were removed, and unconfirmed layouts are reported as unknown.
- **The engine does not close the socket after `end_call`** (the probe saw close 1006 after its own 5 s timeout). The gateway now finishes on `call_ended` and closes the upstream itself. A new test asserts that ending takes under 250 ms.
- **`sample_rate` is per frame.** The gateway forwards changes to the browser (`audio_format`), and the player adopts the new rate instead of assuming 24 kHz.
- **The first probe spoke over the agent's greeting**, so no user frames were captured. The probe now waits for the greeting's mark, speaks, then waits for the reply, and records enum values (`format`, `sample_rate`, `role`, `is_final`).
- **A flaky e2e test exposed a real UI race.** The per-tab call lock was released only after playback drained (up to 4 s), so "Continue with Nora" right after a call was rejected as busy, and the panel showed Maya's transcript under Nora's name. Teardown now releases the lock and all refs synchronously, drains the old player in the background, and ignores late frames from a finished socket. The panel persona comes from the actual session. Verified with `--repeat-each=4` (24/24).
- **A placeholder integration test** asserted nothing. It was replaced with a real `invalid_config`/1008 test (tool URL on a non-HTTPS host).
- **A live smoke test through the gateway** was added (`scripts/live-smoke.ts`). It passed for all three agents.

**Verified:** probe PASS (full); smoke:live PASS × 3 roles; integration 23/23.
**Remaining risk:** live Custom Tool calls are untested (no public HTTPS URL).

## Pass 3: security and privacy

**Checks:** secret scan of tracked files and the client bundle (clean before every commit); e2e and live smoke assert that the browser never receives the token, the signing secret, `alebex.token.`, tool headers or bearer strings; the diagnostics page shows booleans only; the logger masks secrets.

**Findings and fixes**
- **Browser ticket** moved from the URL query to a WebSocket subprotocol (`guardian.ticket.<t>`), keeping it out of URLs and logs; it is single-use.
- **Redaction masked "card ending 4417"** (a last-4 reference, not a secret). Exempted; amounts, case IDs, ports and paths stay readable.
- **Logs were over-redacted:** the port in `127.0.0.1:3001` became `[code]`, and `tokenConfigured: true` was masked because of its key name. Codes can no longer follow `:` or `/`, secret-name masking skips booleans, and the log field was renamed `credentialVariable`.
- **`pnpm audit`** found 3 dev-only advisories (Vitest 3 path traversal; esbuild dev server under tsup). Upgraded Vitest to 4.1.x and overrode esbuild to ≥ 0.28.1. The audit is now clean.
- **Defaults changed** from `localhost` to `127.0.0.1` for the gateway URL and origin (macOS can resolve `localhost` to `::1` while the gateway binds IPv4 only).
- **Tool tokens are verified** for signature, expiry, session match across header, URL and token, role allowlist, live call state and envelope; covered by 8 unit tests including forged-scope and ended-call cases.

**Remaining risk:** demo and operator APIs are unauthenticated (localhost-only posture, documented).

## Pass 4: UX and accessibility

**Method:** Playwright screenshots (desktop 1280, mobile 390), inspected visually.

**Findings and fixes**
- **A space appeared before every comma and full stop across the site.** The global `font-feature-settings: "tnum"` made Schibsted Grotesk's punctuation tabular-width. Tabular figures now apply only to the risk score.
- **Timestamps were letter-spaced** by the same feature; `nums` was removed from times.
- **The control-room timeline was oldest-first**, pushing new events out of view. It is now newest-first with a clear heading; the Command Center stays chronological.
- **Template-style `A · B` meta strings** were replaced with plain commas throughout the UI and audit trail.
- **Mobile:** the brand wrapped onto three lines (now `nowrap`; "concept" hidden below `sm`); the call panel moves to the top while a call is live or ringing; the reverse-auth seal is repeated directly under the call on phones.
- **The Command Center showed opaque session IDs** in tool calls; it now shows time and agent name.
- **A misleading transcript checkbox** in the Command Center was removed (stored text is already redacted).
- **Accessibility:** the risk meter is a `role="meter"` with a value text; the incoming call is an `alertdialog` with Answer focused and Escape to decline; `aria-live` on call status, transcript and timeline; screen-reader "done"/"not done" on actions; skip link; visible focus rings; `prefers-reduced-motion` disables the ring, pulse and seal animations.
- Added React Testing Library tests (7) and `eslint-plugin-react-hooks` (rules-of-hooks, exhaustive-deps: clean).

**Verified:** e2e 6/6 including the phone-width no-horizontal-scroll check.
**Remaining risk:** no focus trap inside the incoming-call dialog (focus starts on Answer; Escape closes).

## Pass 5: hackathon polish

**Findings and fixes**
- **In live voice-only mode nothing could issue the reverse-auth phrase**, the centrepiece of the demo. Added **Issue reverse-auth phrase** to the operator controls, and the demo script marks each operator click.
- The agent prompts tell the agents never to invent a phrase, case or ticket when a tool is unavailable, which prevents hallucinated reverse authentication in voice-only calls.
- Written: README, architecture, protocol notes, agent setup (three copy-paste prompts), demo script (full, fallbacks, 90-second), security, limitations, test report and handoff.
- **Final gate:** lint, typecheck, 95 unit, 23 integration, 6 e2e (18/18 over 3 repeats), build, secret scan. All green.

**Not added after the final green run:** no new features.
