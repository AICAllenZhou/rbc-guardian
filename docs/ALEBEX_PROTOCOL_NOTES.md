# Alebex Voice Engine: browser-call protocol notes

These notes cover what Guardian relies on, where each fact comes from, and what is still unknown. The adapter in `packages/alebex-protocol/src/frames.ts` implements exactly the **confirmed** column; anything else is reported as an unknown frame, with its shape, in diagnostics.

## Sources

| Source | What it covers |
|---|---|
| `AGENTS.md` (Alebex phone-call guide, "Custom tools") | URL of the tools contract, `start_call` with `customTools`, `invalid_config` error with close `1008`, tool envelope, limits, reserved names, schema subset |
| `AGENTS (1).md` (Streaming ASR guide) | Same auth scheme (`alebex.token.<token>` subprotocol), PCM16LE 16 kHz mono binary input, 200 ms frames |
| **Live probe**, `scripts/probe-alebex-voice.ts` | All server→client frame shapes below. Raw report (shapes and enum values only): `docs/probe/last-probe.json` |
| **Live gateway smoke test**, `scripts/live-smoke.ts` | The same frames through the Guardian gateway, for all three agents. Reports: `docs/probe/live-smoke-*.json` |

Probes ran on 2026-09-24 against `wss://api.voice.alebex.ai/public/ws/call` with the project's key and the three configured agents.

## Connection

| Item | Value | Status |
|---|---|---|
| URL | `wss://api.voice.alebex.ai/public/ws/call` | Confirmed |
| Auth | Subprotocol `alebex.token.<token>`; the server echoes it back | Confirmed (handshake ≈ 340–470 ms) |
| Bad token | HTTP 403 on the upgrade (per the ASR guide) | Documented; covered by the mock and tests, not triggered live |

## Client → engine

| Frame | Shape | Status |
|---|---|---|
| Start | `{"type":"start_call","agent":{"id":"…"},"customTools":[…]}`; Guardian omits `customTools` when empty | Documented; confirmed |
| Mic audio | Binary frames, PCM16LE mono 16,000 Hz, 6,400 bytes (200 ms) | Documented; confirmed (the agent transcribed the synthetic phrase) |
| Mark echo | The received mark object, sent back verbatim, e.g. `{"type":"mark","name":"…"}` | Confirmed; the engine continued normally after each echo |
| End | `{"type":"end_call"}` | Documented; confirmed |

## Engine → client (confirmed live)

| Frame | Shape | Observed values |
|---|---|---|
| `call_started` | `{type, call_id}` | once, first |
| `audio` | `{type, data, format, sample_rate}`, where `data` is base64 PCM16LE | `format: "pcm16"`, `sample_rate: 24000`; about 5,120-character payloads |
| `mark` | `{type, name}` | one per agent utterance, after its audio |
| `transcript` | `{type, text, is_final, role}` | `role: "user"` only; `is_final: false` only. Partials are snapshots: assign, never append |
| `conversation_message` | `{type, role, content, timestamp}` | `role: "assistant"` or `"user"`; one per committed turn |
| `clear_audio` | `{type}` | sent when the user spoke over the agent (barge-in) |
| `call_ended` | `{type}` | arrives about 270 ms after `end_call` |
| `error` | `{type, code, message}` | unknown agent ID gives `code: "payload_unavailable"`, then close **1011** |

Agent audio **never** arrived as binary frames. The gateway reports any binary downstream frame as unknown instead of guessing its format.

## Behaviour that shaped the implementation

- **The engine does not close the socket after `end_call`.** It sends `call_ended` and leaves the connection open; the probe's socket was still open 5 s later. The gateway treats `call_ended` as the end and closes the upstream itself, so ending is prompt and the browser gets close code 1000.
- **An unknown agent is `payload_unavailable` + 1011**, not the `AGENT_NOT_FOUND` wording in the phone guide. The gateway treats any error frame followed by a close as a non-recoverable configuration error (close 4422 to the browser, message "check the agent ID"), not as a dropped connection.
- **There are no agent-side transcript partials.** The agent's text arrives as a single `conversation_message`, so the UI shows agent turns whole and user turns live.
- **Sample rate is sent on every audio frame.** It is 24,000 today, but the gateway forwards a change to the browser (`audio_format`) instead of assuming.
- **Marks are echoed only after simulated or real playback reaches them.** A mark flushed by `clear_audio` is never echoed. The gateway also refuses to forward an echo for a mark it did not issue, and forwards each one only once.

## Still unconfirmed

| Question | Why it matters | Current handling |
|---|---|---|
| Does `transcript` ever carry `is_final: true`? | Final user text | Committed from `conversation_message`; a final transcript is also committed if one arrives |
| Custom Tool calls during a **browser** call | Live tool workflow | Contract is documented and implemented; **not live-tested**, because no public HTTPS URL was configured |
| Engine-initiated hang-up | e.g. the agent says goodbye | `call_ended` while active, or close 1000, ends the session as `assistant-ended-call` |
| Idle timeout on a quiet socket | Long silences | The browser always streams mic frames (silence when muted), so none should occur |
| Upgrade 429/503 when at capacity | Retry behaviour | Retried twice with exponential backoff before `start_call` only; never retried after the call started |

## Re-running the probe

```bash
pnpm probe:alebex               # full probe with the Sentinel (or default) agent
pnpm probe:alebex --auth-only   # handshake + deliberately unknown agent; no conversation
pnpm smoke:live --role sentinel # full path through the Guardian gateway
```

The probe records frame types, field shapes and the values of enum-like fields (`format`, `sample_rate`, `role`, `is_final`, `code`). It never records the token, audio or transcript text. The synthetic phrase ("I received a suspicious bank call and I need help.") is generated with macOS `say` into a temp directory and deleted afterwards.
