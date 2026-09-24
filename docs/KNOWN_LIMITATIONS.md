# Known limitations (P1)

- **Inbound and outbound are browser workflow directions, not phone calls.** "Call Guardian TrustLine" and the "Incoming Guardian call" overlay both open a WebSocket voice session in your browser tab. The overlay is labelled "Simulated browser call". There is no Twilio, no phone number and no call to `POST /public/call/phone`.
- **Agent prompt, voice and model are configured in the Alebex console.** The app only selects an agent ID per role. See [ALEBEX_AGENT_SETUP.md](ALEBEX_AGENT_SETUP.md).
- **Live Custom Tools need a public HTTPS URL.** Alebex refuses `http://`, loopback and private hosts. Without `PUBLIC_TOOL_BASE_URL`, live mode runs **voice-only**: no tools are sent, so the agent cannot read the case, issue the reverse-auth phrase or lock the card. The operator controls in the control room apply those actions by hand, labelled as operator actions. `pnpm tunnel` starts a temporary Cloudflare or ngrok tunnel if one is installed; nothing is installed automatically.
- **Live Custom Tool calls during a browser call have not been tested live.** The tool contract is implemented to the documented spec and verified end to end against the mock engine, which calls tools over HTTP exactly as documented. The live voice path itself (audio, marks, transcripts, clear_audio, end) was verified live for all three agents.
- **The end-of-call webhook is not wired.** It is optional, needs a stable public URL, and is configured in the console.
- **No real banking integration.** Customers, transactions, locks, flags and reviews are sandbox rows in local SQLite. No real RBC API or data is involved.
- **The mock runtime has no speech recognition.** Suggested reply chips stand in for what you would say. The mock's audio is a soft tone, not speech, so the demo is fully rehearsable offline. Use live mode for real voices.
- **Reverse authentication is a UI simulation.** The phrase appears in this web app, standing in for the customer's banking app; a real deployment would push it to the authenticated mobile app.
- **Local-only security posture.** The demo and operator APIs have no auth; see [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md).
- **Single demo customer.** All flows use the seeded Sarah Chen profile.
- **No automatic mid-call reconnect.** A dropped upstream ends the session with a recoverable error. Case state is kept and the user starts a new call, which avoids replaying side effects under a new `call.id`.

## Future P2

1. Telephony: a Twilio-backed upstream using `POST /public/call/phone`, true inbound routing, and the end-of-call webhook for transcripts and recordings.
2. A stable HTTPS deployment for tools, with gateway auth and tunnel ingress restricted to `/tools/*`.
3. Push the reverse-auth phrase to a real authenticated mobile surface, and support more customers and scenarios.
