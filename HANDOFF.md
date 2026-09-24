# Handoff: RBC Guardian P1

> Hackathon concept demo. Not an official RBC product. No real banking action is performed.

## Where things are

| Item | Value |
|---|---|
| Branch | `feat/rbc-guardian-p1` (a new repo: `git init` in this folder; `main` has no commits) |
| Final code commit | `c5cebe4` (`docs: add agent setup demo script and handoff`); this file is committed on top of it |
| Pushed remote branch | **None: not pushed.** See below |
| Deployment | None. No Vercel, no hosting, no Twilio |

### Why it is not pushed

This folder had no git repository and no GitHub remote. `git push -u origin feat/rbc-guardian-p1` fails with:

```
fatal: 'origin' does not appear to be a git repository
fatal: Could not read from remote repository.
```

`gh` is authenticated (account `AICAllenZhou`), but creating a new GitHub repository was not explicitly requested, so it was left for you. To publish the branch to a new **private** repository:

```bash
cd "/Users/allenzhou/Documents/RBC Alebex Voice Agent"
pnpm secret-scan                                   # must print "clean"
gh repo create AICAllenZhou/rbc-guardian --private --source . --remote origin
git push -u origin feat/rbc-guardian-p1
```

Or, for an existing repository: `git remote add origin <url> && git push -u origin feat/rbc-guardian-p1`. Do not push `main`; it is empty.

## Current `.env` state (names only)

`ALEBEX_API_KEY`, `ALEB_API_KEY`, `ALEBEX_MODE`, `ALEBEX_AGENT_TRUSTLINE_ID`, `ALEBEX_AGENT_SENTINEL_ID`, `ALEBEX_AGENT_RECOVERY_ID`, `TOOL_SIGNING_SECRET`, `DATABASE_URL`, `APP_ORIGIN`, `GATEWAY_ORIGIN`.

`pnpm dev` starts in **live voice-only** mode: token and all three agents are configured, `PUBLIC_TOOL_BASE_URL` is not, so tools are off. `.env` is git-ignored and was never read into any output.

## Commands run (final gate)

```bash
pnpm install
pnpm lint                      # 0 problems
pnpm typecheck                 # 4 packages
pnpm test                      # 95 passed
pnpm test:integration          # 23 passed
CAPTURE_SCREENSHOTS=1 pnpm test:e2e     # 6 passed
pnpm exec playwright test --repeat-each=3   # 18/18
pnpm build                     # all packages + Next.js
pnpm secret-scan               # clean
pnpm audit                     # no known vulnerabilities
pnpm probe:alebex              # live PASS (full)
pnpm smoke:live --role sentinel   # live PASS
pnpm smoke:live --role trustline  # live PASS
pnpm smoke:live --role recovery   # live PASS
```

Details: [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

## Live Alebex testing

- **Performed:**
  - an auth-only probe, and a full probe with a real agent;
  - a gateway smoke call for each of the three agents;
  - audio in and out, user transcripts, conversation messages, `clear_audio` on barge-in, mark echo after playback, `call_ended`, clean close;
  - a check that no secrets reach the browser socket.
- **The live protocol shapes are now confirmed** and the adapter accepts only them. See [docs/ALEBEX_PROTOCOL_NOTES.md](docs/ALEBEX_PROTOCOL_NOTES.md). Two findings were not in the docs: an unknown agent gives `payload_unavailable` + close 1011, and the engine does not close the socket after `end_call`.
- **Skipped:**
  - live Custom Tool calls: no public HTTPS URL, and no `cloudflared` or `ngrok` installed;
  - a manual browser call with a real microphone: no one was at the machine.

## Screenshots

`docs/screenshots/`: `01-landing-desktop`, `02-incoming-call`, `03-reverse-auth`, `04-protected`, `05-command-center`, `06-landing-mobile`, `07-demo-mobile`. They are mock mode, captured by Playwright.

## Remaining issues

| Priority | Issue |
|---|---|
| P1 | Live Custom Tools are untested against the real engine. Install `cloudflared` (`brew install cloudflared`), run `pnpm tunnel`, set `PUBLIC_TOOL_BASE_URL`, then run the Sentinel flow and check the tool timeline |
| P1 | Before a live demo, paste the prompts from [docs/ALEBEX_AGENT_SETUP.md](docs/ALEBEX_AGENT_SETUP.md) into the three console agents. Their current prompts are unknown to this project |
| P2 | Demo and operator APIs are unauthenticated. When tunnelling, expose only `/tools/*` |
| P2 | The incoming-call dialog has no focus trap (Answer is focused; Escape declines) |
| P2 | A manual rehearsal with a real mic and headset in Chrome and Safari |

## Next three highest-value P2 tasks

1. **Live tool loop:** a tunnel with ingress restricted to `/tools/*`, then a live Sentinel run where Atlas issues the phrase, locks the card once and requests review by himself; add that run to `smoke:live` when `PUBLIC_TOOL_BASE_URL` is set.
2. **Telephony adapter:** a Twilio-backed upstream via `POST /public/call/phone` for real outbound Sentinel calls and inbound TrustLine routing, plus the end-of-call webhook. The case core, tools and UI stay as they are.
3. **Hardening for a shared demo:** gateway auth for `/api/*`, a scoped SSE stream, CSP headers, and a stable HTTPS host for the tool endpoints.
