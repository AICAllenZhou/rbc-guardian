# Demo script

> Hackathon concept demo. Not an official RBC product. No real banking action is performed.

Full version: about 3½ minutes. A 90-second version is at the end.

## Before you present

1. `pnpm dev`, then open `http://localhost:3000`.
2. Choose the runtime:
   - **Mock** (`ALEBEX_MODE=mock`): works offline. You click the suggested replies instead of speaking. Agent audio is a soft tone.
   - **Live** (`ALEBEX_MODE=live`): real Alebex voices. Use a headset to avoid echo. With `PUBLIC_TOOL_BASE_URL` set, the agent drives the case itself. Without it (voice-only), open **Operator controls** and click the actions at the moments marked **[operator]** below.
3. In `/demo`, click **Reset demo**. Check the runtime chip in the top right.
4. Open `/settings` once. Every row you need should say "Yes".

## Full run (about 3½ minutes)

### 1. The idea (30 s). Landing page `/`

> "Scam calls work because we're asked to trust the caller first. Guardian flips that: **the bank proves itself first.** When Atlas calls, he reads a phrase that only your real app is showing. Same words, it's your bank. Different words, hang up."

Point at the BLUE MAPLE card, then scroll briefly to **What runs where**:

> "Everything you hear is the Alebex Voice Engine: listening, reasoning and speaking. Our gateway keeps the key off the device, gives each agent only the tools it needs, and runs the mock bank."

Click **Launch the live demo**.

### 2. Detection (20 s). `/demo`

> "Sarah is in Vancouver. A 2,840-dollar Apple Store purchase just happened in Miami, on a device we've never seen, with no travel notice."

Click **Trigger fraud detection**. The case appears at **risk 92**, and the simulated incoming call rings.

> "This is a browser call, not a phone call. Atlas is our Fraud Sentinel."

Click **Answer**.

### 3. Reverse authentication (40 s)

Atlas says he will never ask for a password, PIN or one-time code, then issues the phrase. The gold card appears on the right.
**[operator]** *Issue reverse-auth phrase* (voice-only mode).

> "Look: the phrase on screen is what Sarah's app shows. Atlas has to read it to me."

When Atlas reads it, say (or click in mock):

> **"Yes, it matches."**

**[operator]** *Customer confirmed phrase.* The card turns to "Matched".

### 4. The transaction and the scam (40 s)

Atlas describes the Miami purchase. Say:

> **"No, that wasn't me. Earlier someone called saying they were RBC and asked me for a code."**

**[operator]** *Customer denies purchase*, then *Caller asked for a code*. Risk moves **92 → 96 → 99**. Point at the tool timeline:

> "Every answer is a tool call, and the score is transparent rules, not a black box."

### 5. Protection with consent (40 s)

Atlas asks: "Would you like me to place a temporary lock on your card?"

> **"Yes, please lock it."**

**[operator]** *Lock card*, *Flag transaction*, *Request human review*. All three protective actions turn green.

> "Notice he asked first. He can't lock anything without an explicit yes. And the model called the lock tool twice. That happens, so the second call was recognised as a duplicate and ignored." *(Point at "Duplicate temporary_card_lock call ignored" in the timeline; mock mode always shows it.)*

> **"No, that's all. Thank you."**

Click **End call**.

### 6. Command Center (30 s)

Click **Open Command Center**.

> "Here's the audit trail a fraud analyst would see: signals and points, risk history, every tool call with timing, the redacted transcript, and the human-review ticket. It exports as JSON."

### 7. A different agent (optional, 30 s)

Back in `/demo`, click **Continue with Nora, Recovery**.

> "New call, different Alebex agent, different voice, different permissions. Nora can't issue phrases or lock cards; she explains what was done and gives a recovery checklist."

Say **"Yes, please."** once, then **End call**.

## Expected agent behaviour

| Moment | Atlas should | If it doesn't |
|---|---|---|
| Opening | Disclose the demo; promise not to ask for passwords, PINs or codes | "Atlas, can you confirm you won't ask for my PIN?" |
| Phrase | Call `issue_reverse_auth_phrase` and read it verbatim | "Can you read me the Guardian phrase first?" (voice-only: issue it from Operator controls) |
| Transaction | Describe amount, merchant, city and device | "What was the purchase?" |
| Lock | Ask for consent before locking | "Please don't do anything without asking me." |
| Wrap-up | Summarise the actions and the ticket | "What did you do on my account?" |

## Fallback lines

- **Agent is silent for 5+ seconds:** "Hi Atlas, are you there?" If still silent, end the call and click **Replay incoming call**.
- **Mic not picked up:** check the mic indicator in the call panel. Mute, then unmute. In the worst case, switch to mock mode, which needs no mic.
- **Phrase doesn't appear (voice-only):** Operator controls → *Issue reverse-auth phrase*.
- **Gateway banner "isn't running":** restart `pnpm dev`. Cases are in SQLite, so they survive.
- **Anything odd:** **Reset demo** and start at step 2. The whole run is deterministic in mock mode.

## 90-second version

1. **(15 s)** Landing: "The bank proves itself first: a phrase only your real app shows." Click **Launch the live demo**.
2. **(10 s)** **Trigger fraud detection**: "2,840 dollars in Miami, unknown device, risk 92." Click **Answer**.
3. **(20 s)** Atlas reads the phrase. "It matches." Point at the gold card.
4. **(20 s)** "That wasn't me, and someone called asking for a code." Risk goes to 99.
5. **(15 s)** "Yes, lock it." Three protective actions turn green; point out the ignored duplicate.
6. **(10 s)** **End call**, then **Open Command Center**: "Full audit trail, redacted transcript, human review queued."
