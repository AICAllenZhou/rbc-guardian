# RBC Guardian P1 — Implementation Plan

> Hackathon concept demo. Not an official RBC product. No real banking action is performed.

## 1. Audit findings (start of work)

| Item | Finding | Consequence |
|---|---|---|
| Repository | Empty folder containing only `.env`; not a git repo; no remote | Greenfield build using the fallback architecture; `git init` on `feat/rbc-guardian-p1`; `.env` git-ignored before first commit |
| `.env` | Contains a single variable, `ALEB_API_KEY` (value never read by the assistant) | Support `ALEB_API_KEY` as an alias of `ALEBEX_API_KEY` (plus `ALEBEX_VOICE_TOKEN`). **No agent IDs are configured** |
| Alebex docs | `~/Downloads/AGENTS.md` (phone calls + Custom Tools contract), `~/Downloads/AGENTS (1).md` (Streaming ASR), `Alebex API Reference.docx` (lead/message REST — not used) | Custom Tools contract is fully documented. The browser `ws/call` contract is documented only in one paragraph; `audio`, `mark`, `transcript`, `conversation_message` field shapes are **not** documented anywhere available |
| Public docs | `docs.alebex.ai` does not resolve; `AICAllenZhou/alebex-starter` covers the phone path only | Frame field shapes must come from a live probe with a real agent ID |
| Tooling | Node 25, npm, ffmpeg, `say`, `gh` (authenticated). No pnpm, no cloudflared/ngrok | pnpm installed via npm; tunnel script detects cloudflared/ngrok and prints instructions if absent |

## 2. Architecture decisions

- **pnpm workspace**: `apps/web` (Next.js App Router, Tailwind v4), `apps/gateway` (Fastify + `ws`), `packages/shared` (Zod schemas, tool catalog, risk rules, redaction), `packages/alebex-protocol` (frame types, validators, audio DSP, playback/mark state machine).
- **SQLite via Node's built-in `node:sqlite`** instead of Drizzle + a native driver. Node 25 would require compiling `better-sqlite3`; the built-in driver removes that failure mode. A thin repository module owns all SQL.
- **The gateway owns the Alebex socket.** The browser talks to `ws://localhost:3001/voice`; only the gateway knows the token. Tool definitions and short-lived HMAC tool tokens are minted server-side per session.
- **Tolerant protocol adapter.** Every inbound Alebex frame passes through `parseServerFrame()`, which normalises the few plausible encodings of unconfirmed fields into one internal shape, and records unknown frames/fields in a diagnostics ring buffer. Assumptions are listed in `docs/ALEBEX_PROTOCOL_NOTES.md` and are exercised by the probe.
- **Mark echo is verbatim.** Because the `mark` field name is unconfirmed, the browser returns the exact mark frame JSON back to the gateway once playback has reached it, and the gateway forwards it unchanged. That is correct whichever field (`name`, `id`, `mark`) the engine uses.
- **Mock mode is a real WebSocket server** speaking the same frames (`apps/gateway/src/mock/mock-alebex.ts`). It reads `customTools` from `start_call` and calls them over HTTP with their signed headers, exactly as Alebex would. Because there is no ASR in mock mode, the UI offers scripted "say this" reply chips that the gateway forwards to the mock as a Guardian-only `mock_user_utterance` control frame (never sent upstream in live mode).
- **Three runtime modes**: `mock`, `live` (tools enabled — requires `PUBLIC_TOOL_BASE_URL`), `live-voice-only` (live voice, tools omitted, operator console buttons drive the same tool code paths and are labelled "operator action").

## 3. Work breakdown

1. Workspace, lint, typecheck, test harness.
2. `packages/alebex-protocol`: PCM16 conversion, deterministic 16 kHz resampler, 200 ms framer, frame parser, playback timeline with mark accounting, transcript store.
3. `packages/shared`: domain types, tool catalog + JSON schemas (no `$ref/oneOf/anyOf/allOf`), role allowlists, risk engine, redaction, tool-token signing.
4. `apps/gateway`: env validation, SQLite store + seed, tool endpoints with idempotency, voice session state machine + upstream proxy, SSE event bus, diagnostics, mock Alebex server.
5. `apps/web`: landing, demo control room with incoming-call overlay, voice panel (AudioWorklet mic + PCM player), case command center, settings/diagnostics.
6. `scripts/probe-alebex-voice.ts`, `scripts/secret-scan.mjs`, `scripts/tunnel.sh`.
7. Tests: unit, integration (gateway ↔ mock Alebex ↔ tools), Playwright e2e in mock mode.
8. Docs and five iteration passes logged in `docs/ITERATION_LOG.md`.

## 4. Git / delivery

No GitHub remote exists for this folder. Work is committed on `feat/rbc-guardian-p1`. Creating a new GitHub repository is an outward-facing action that the brief did not authorise explicitly, so the handoff documents the exact commands instead of creating one silently. No Vercel, no Twilio.
