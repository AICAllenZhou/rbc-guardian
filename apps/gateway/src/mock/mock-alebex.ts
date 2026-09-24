/**
 * Alebex-compatible MOCK Voice Engine for offline development and tests.
 *
 * It speaks the frames this project's adapter expects (see
 * docs/ALEBEX_PROTOCOL_NOTES.md — the audio/mark/transcript field layouts are
 * this project's working assumption until confirmed by a live probe):
 *   ← audio {type:"audio", data:<base64 PCM16LE 24 kHz>}
 *   ← mark  {type:"mark", name}          → expects the same object echoed back once heard
 *   ← transcript {type:"transcript", role, text, final}
 *   ← conversation_message {type:"conversation_message", role, content}
 *   ← clear_audio {type:"clear_audio"}    on barge-in
 *   ← error {type:"error", code, message} then close 1008 on bad config
 *
 * Because it has no speech recognition, the "user" speaks through a mock-only
 * `mock_user_utterance` frame, and the mock suggests replies with `mock_hint`.
 * Tools are invoked over HTTP exactly like the engine: POST {tool, arguments, call}
 * with the tool's own headers.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { bytesToBase64, int16ToLeBytes, OUTPUT_SAMPLE_RATE, synthTone, type CustomToolDefinition } from "@guardian/alebex-protocol";
import { validateAlebexSchema, validateToolName, MAX_TOOLS_PER_CALL } from "@guardian/shared";

export interface MockCallRecord {
  id: string;
  agentId: string | null;
  subprotocolOk: boolean;
  startCalls: number;
  toolNames: string[];
  audioBytesIn: number;
  audioFramesIn: number;
  frameSizes: Set<number>;
  marksSent: string[];
  marksAcked: string[];
  toolResults: { tool: string; status: number; body: unknown }[];
  endCallReceived: boolean;
  closed: boolean;
}

export interface MockAlebexOptions {
  port?: number;
  /** 1 = real-time-ish pacing, 0 = as fast as possible (tests). */
  pace?: number;
  /** Duplicate the card-lock tool call, as a model legitimately may, to demonstrate idempotency. */
  duplicateLockCall?: boolean;
}

export interface MockAlebex {
  url: string;
  port: number;
  calls: MockCallRecord[];
  close(): Promise<void>;
}

type Role = "trustline" | "sentinel" | "recovery";

function roleFromAgent(agentId: string): Role {
  if (/trust|maya/i.test(agentId)) return "trustline";
  if (/recover|nora/i.test(agentId)) return "recovery";
  return "sentinel";
}

const isNo = (t: string) => /^\s*(no|nope|not)\b|doesn'?t match|does not match|wasn'?t me|not me|didn'?t|don'?t recogni|not right now/i.test(t);
const isYes = (t: string) => /\b(yes|yeah|yep|correct|matches|sure|please|go ahead|that was me|i made it|lock it)\b/i.test(t);
const mentionsCode = (t: string) => /code|otp|verification|pin\b|password|passcode/i.test(t);
const mentionsContact = (t: string) => /call|phoned|rang|text|message|email|sms/i.test(t);
const sharedCode = (t: string) => /\b(gave|shared|read (it|them)|told them)\b/i.test(t) && !/didn'?t|did not|never|no,/i.test(t);
const wantsHuman = (t: string) => /\b(person|human|specialist|someone real|recovery)\b/i.test(t);

export async function startMockAlebex(opts: MockAlebexOptions = {}): Promise<MockAlebex> {
  const pace = opts.pace ?? 1;
  const calls: MockCallRecord[] = [];
  const http: Server = createServer((_req, res) => {
    res.writeHead(426).end("upgrade required");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  http.on("upgrade", (req, socket, head) => {
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
    const tokenProto = protocols.find((p) => p.startsWith("alebex.token."));
    const token = tokenProto?.slice("alebex.token.".length) ?? "";
    if (!req.url?.startsWith("/public/ws/call")) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    if (!token || token === "invalid") {
      socket.end("HTTP/1.1 403 invalid or missing token\r\n\r\n");
      return;
    }
    if (token === "at-capacity") {
      socket.end("HTTP/1.1 503 at capacity\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const record: MockCallRecord = {
        id: `public-${randomUUID()}`,
        agentId: null,
        subprotocolOk: true,
        startCalls: 0,
        toolNames: [],
        audioBytesIn: 0,
        audioFramesIn: 0,
        frameSizes: new Set(),
        marksSent: [],
        marksAcked: [],
        toolResults: [],
        endCallReceived: false,
        closed: false,
      };
      calls.push(record);
      runCall(ws, record, token, pace, opts.duplicateLockCall ?? true);
    });
  });

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `ws://127.0.0.1:${port}/public/ws/call`,
    port,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        http.close(() => resolve());
      }),
  };
}

function runCall(ws: WebSocket, rec: MockCallRecord, token: string, pace: number, duplicateLock: boolean): void {
  let tools: CustomToolDefinition[] = [];
  let role: Role = "sentinel";
  let stage = "init";
  let speaking: { cancelled: boolean } | null = null;
  let markSeq = 0;
  let queue: Promise<void> = Promise.resolve();
  const startedAt = new Date().toISOString();
  const memo: Record<string, string> = {};

  const send = (obj: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms * pace)));

  async function say(text: string): Promise<void> {
    const token = { cancelled: false };
    speaking = token;
    const words = text.split(/\s+/);
    const seconds = Math.min(12, Math.max(0.6, words.length * 0.26));
    const chunkSec = 0.2;
    const chunks = Math.ceil(seconds / chunkSec);
    const tone = synthTone(seconds, OUTPUT_SAMPLE_RATE, role === "trustline" ? 210 : role === "recovery" ? 195 : 150);
    const perChunk = Math.round(chunkSec * OUTPUT_SAMPLE_RATE);
    for (let i = 0; i < chunks; i++) {
      if (token.cancelled || ws.readyState !== WebSocket.OPEN) return;
      const slice = tone.subarray(i * perChunk, Math.min(tone.length, (i + 1) * perChunk));
      send({ type: "audio", data: bytesToBase64(int16ToLeBytes(slice)) });
      const upto = Math.ceil(((i + 1) / chunks) * words.length);
      send({ type: "transcript", role: "agent", text: words.slice(0, upto).join(" "), final: false });
      await sleep(chunkSec * 700);
    }
    if (token.cancelled) return;
    const name = `utt-${++markSeq}`;
    rec.marksSent.push(name);
    send({ type: "mark", name });
    send({ type: "conversation_message", role: "agent", content: text });
    if (speaking === token) speaking = null;
  }

  async function hear(text: string): Promise<void> {
    const words = text.split(/\s+/);
    for (let i = 1; i <= words.length; i += 3) {
      send({ type: "transcript", role: "user", text: words.slice(0, i).join(" "), final: false });
      await sleep(40);
    }
    send({ type: "conversation_message", role: "user", content: text });
  }

  async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const def = tools.find((t) => t.name === name);
    if (!def) return { error: `tool ${name} not on this call` };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), def.timeoutMs ?? 8000);
    try {
      const res = await fetch(def.url, {
        method: "POST",
        headers: { ...(def.headers ?? {}), "Content-Type": "application/json" },
        body: JSON.stringify({ tool: name, arguments: args, call: { id: rec.id, agentId: rec.agentId, startedAt } }),
        signal: ctl.signal,
        redirect: "manual",
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      rec.toolResults.push({ tool: name, status: res.status, body });
      return res.ok ? body : { error: String(body.error ?? `HTTP ${res.status}`) };
    } catch (err) {
      rec.toolResults.push({ tool: name, status: 0, body: String(err) });
      return { error: `tool ${name} failed` };
    } finally {
      clearTimeout(timer);
    }
  }

  const hint = (replies: string[]) => send({ type: "mock_hint", replies });

  async function opening(): Promise<void> {
    if (role === "sentinel") {
      await say("Hello, this is Atlas with Guardian Fraud Sentinel. This is a concept demo, and I will never ask for your password, PIN, or a one-time code. I'm calling about unusual activity on your card, but first, let me prove I'm really the bank.");
      await tool("get_guardian_case", {});
      const r = await tool("issue_reverse_auth_phrase", {});
      memo.phrase = String(r.phrase ?? "the phrase");
      await say(`Your Guardian app is now showing a two-word phrase. Mine reads: ${memo.phrase}. Does that match what you see on your screen?`);
      hint([`Yes, it matches. ${titleCase(memo.phrase)}.`, "No, it doesn't match."]);
      stage = "await_auth";
    } else if (role === "trustline") {
      await say("Hi, you've reached Guardian TrustLine. I'm Maya. This is a concept demo. I will never ask for your password, PIN, or a one-time code.");
      const r = await tool("issue_reverse_auth_phrase", {});
      memo.phrase = String(r.phrase ?? "the phrase");
      await say(`So you know you've really reached us, your Guardian app now shows the phrase ${memo.phrase}. What made you call today? A suspicious call, a text, an email, or a transaction?`);
      hint(["Someone called saying they were RBC fraud and asked me to read them a code from a text.", "I got a text with a link saying my account is locked."]);
      stage = "await_report";
    } else {
      const c = await tool("get_guardian_case", {});
      memo.caseId = String(c.caseId ?? "your case");
      const done: string[] = [];
      if (String(c.cardLocked ?? "").startsWith("yes")) done.push("your card is temporarily locked");
      if (c.transactionFlagged === "yes") done.push("the suspicious purchase is flagged");
      if (String(c.humanReview ?? "").startsWith("requested")) done.push("a fraud specialist has your case in their queue");
      await say(`Hi, I'm Nora from Guardian Recovery. This is a concept demo, and I'll never ask for a password, PIN, or code. I'm looking at case ${memo.caseId}. ${done.length ? `So far, ${done.join(", and ")}.` : "No protective steps have been taken yet."} Would you like me to walk you through a quick safety checklist?`);
      hint(["Yes, please.", "Can a person review my case?"]);
      stage = "await_check";
    }
  }

  async function respond(text: string): Promise<void> {
    if (role === "sentinel") {
      if (stage === "await_auth") {
        if (isNo(text)) {
          await tool("record_customer_response", { response_type: "reverse_auth_mismatch" });
          await say("Thank you for checking. Because the phrase doesn't match, please end this call now and phone the number on the back of your card. I won't discuss anything further.");
          stage = "wrap";
          return;
        }
        await tool("record_customer_response", { response_type: "confirmed_reverse_auth", note: "Phrase matched the Guardian app" });
        await tool("get_recent_transactions", { limit: 3 });
        await say("Thank you for checking. A few minutes ago, a purchase of 2,840 Canadian dollars at the Apple Store in Miami, Florida, was made from a device we don't recognise. Did you make this purchase?");
        hint(["No, that wasn't me. Earlier someone called saying they were RBC and asked me for a code.", "Yes, that was me."]);
        stage = "await_txn";
      } else if (stage === "await_txn") {
        if (isNo(text) || mentionsCode(text)) {
          await tool("record_customer_response", { response_type: "denies_transaction", note: "Customer did not make the Miami purchase" });
          if (mentionsContact(text)) await tool("record_customer_response", { response_type: "reported_impersonation_call", note: "Earlier caller claimed to be RBC" });
          if (mentionsCode(text)) await tool("record_customer_response", { response_type: "was_asked_for_code", note: "Caller asked for a verification code" });
          if (sharedCode(text)) await tool("record_customer_response", { response_type: "shared_code" });
          await say("Thank you for telling me. You did the right thing. A real Guardian agent will never ask you for a code. I'd like to protect your card right away. Would you like me to place a temporary lock on your card? You can remove it later.");
          hint(["Yes, please lock it.", "Not right now."]);
          stage = "await_lock";
        } else {
          await tool("record_customer_response", { response_type: "recognizes_transaction" });
          await say("Thanks for confirming that was you. I've noted it on the case, and no further action is needed.");
          hint(["Thanks, goodbye."]);
          stage = "wrap";
        }
      } else if (stage === "await_lock") {
        if (isYes(text) && !isNo(text)) {
          await tool("temporary_card_lock", { customer_confirmed: true, reason: "Customer denied the Miami purchase and reported a code-request call" });
          if (duplicateLock) await tool("temporary_card_lock", { customer_confirmed: true, reason: "Customer approved a temporary lock" });
          await tool("flag_suspicious_transaction", { reason: "Customer does not recognise it; unknown device in Miami" });
          const r = await tool("request_human_review", { priority: "urgent", summary: "Customer denied a CAD 2,840 Miami purchase and reported a bank-impersonation call asking for a code. Card locked, transaction flagged." });
          await say(`Done. Your card ending 4417 is temporarily locked, the Miami purchase is flagged as suspected fraud, and I've asked a fraud specialist to review your case urgently, ticket ${spell(String(r.ticket ?? ""))}. My colleague Nora from Recovery can walk you through next steps. Is there anything else I can help with?`);
          hint(["No, that's all. Thank you.", "Can I talk to the recovery specialist?"]);
        } else {
          await tool("request_human_review", { priority: "standard", summary: "Customer denied the Miami purchase but declined a card lock." });
          await say("Understood, I won't lock the card. I've asked a specialist to review the case. Is there anything else?");
          hint(["No, that's all. Thank you."]);
        }
        stage = "wrap";
      } else {
        await say(wantsHuman(text) ? "Of course. I'll end here so Nora from Recovery can pick up your case. Remember, Guardian always proves itself first. Goodbye." : "You're welcome. Remember, Guardian will always prove it's us before asking you anything. Take care. Goodbye.");
        stage = "done";
      }
    } else if (role === "trustline") {
      if (stage === "await_report") {
        const channel = /\bcall(ed)?\b|phoned|rang/i.test(text) ? "phone_call" : /text|sms/i.test(text) ? "text_message" : /email/i.test(text) ? "email" : /transaction|charge|purchase/i.test(text) ? "transaction" : "other";
        const claimsBank = /rbc|bank|fraud/i.test(text);
        const r = await tool("create_guardian_case", {
          contact_channel: channel,
          summary: channel === "phone_call" ? "Customer received a call from someone claiming to be the bank." : "Customer received a suspicious message.",
          ...(claimsBank ? { claimed_organization: "RBC fraud department (claimed)" } : {}),
          requested_sensitive_info: mentionsCode(text),
        });
        memo.caseId = String(r.caseId ?? "your case");
        await say(`Thank you for telling me. I've opened case ${spell(memo.caseId)}. Calling us was exactly the right thing to do. Did you share that code, or any other information, with them?`);
        hint(["No, I didn't share anything.", "Yes, I read them the code."]);
        stage = "await_shared";
      } else if (stage === "await_shared") {
        if (sharedCode(text) || (isYes(text) && !isNo(text))) {
          await tool("record_customer_response", { response_type: "shared_code", note: "Customer read the code to the caller" });
          await tool("request_human_review", { priority: "urgent", summary: "Customer reported a bank-impersonation call and shared a verification code." });
          await say("Thank you for being honest. That happens to careful people. I've asked a fraud specialist to review your case urgently. In the meantime, don't respond to any more calls or links from them. Is there anything else?");
        } else {
          await tool("request_human_review", { priority: "standard", summary: "Customer reported a bank-impersonation call requesting a code. Nothing was shared." });
          await say("Good, you're safe. Here are the red flags you spotted: urgency, a request for a code, and a caller you couldn't verify. Caller ID can be faked. I've queued your report for a specialist. Is there anything else?");
        }
        hint(["No, thank you. That's all."]);
        stage = "wrap";
      } else {
        await say("Thanks for calling Guardian TrustLine. Remember, we always prove it's us first. Take care. Goodbye.");
        stage = "done";
      }
    } else {
      if (stage === "await_check") {
        if (wantsHuman(text) && !isYes(text)) {
          const r = await tool("request_human_review", { priority: "standard", summary: "Customer asked for a human to review the case during recovery." });
          await say(`Of course. A specialist has ticket ${spell(String(r.ticket ?? ""))}. Would you still like the quick safety checklist?`);
          hint(["Yes, please."]);
          return;
        }
        await say("Here's your checklist. One: never share a one-time code with anyone, even someone who says they're the bank. Two: review your recent transactions in the app. Three: change your online banking password yourself, only in the official app, never from a link. Four: if a caller says they're the bank, ask them to prove it with a Guardian phrase. Would you like a human specialist to follow up with you?");
        hint(["Yes, please have someone follow up.", "No, I'm all set."]);
        stage = "await_review";
      } else if (stage === "await_review") {
        if (isYes(text) && !isNo(text)) {
          const r = await tool("request_human_review", { priority: "standard", summary: "Recovery follow-up requested by the customer." });
          await say(r.alreadyQueued ? `A specialist already has your case, ticket ${spell(String(r.ticket ?? ""))}. They'll follow up in the Guardian app. I can't promise a specific outcome, but you've done everything right.` : `Done, ticket ${spell(String(r.ticket ?? ""))}. A specialist will follow up in the Guardian app. I can't promise a specific outcome, but you've done everything right.`);
        } else {
          await say("Alright. You've done everything right today. I can't promise a specific outcome on the transaction, but your case is recorded.");
        }
        hint(["Thank you, goodbye."]);
        stage = "wrap";
      } else {
        await say("Take care, and remember: Guardian always proves itself first. Goodbye.");
        stage = "done";
      }
    }
  }

  const enqueue = (fn: () => Promise<void>) => {
    queue = queue.then(fn).catch(() => undefined);
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const n = (data as Buffer).byteLength;
      rec.audioBytesIn += n;
      rec.audioFramesIn++;
      rec.frameSizes.add(n);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case "start_call": {
        rec.startCalls++;
        if (rec.startCalls > 1) return;
        const agent = msg.agent as { id?: unknown } | undefined;
        const agentId = typeof agent?.id === "string" ? agent.id : "";
        rec.agentId = agentId || null;
        if (!agentId) {
          send({ type: "error", code: "invalid_config", message: "agent.id is required" });
          ws.close(1008, "invalid config");
          return;
        }
        if (agentId === "missing-agent") {
          // Mirrors the live engine (probe 2026-09-24): unknown agent → payload_unavailable, close 1011.
          send({ type: "error", code: "payload_unavailable", message: "agent configuration unavailable" });
          ws.close(1011);
          return;
        }
        const list = Array.isArray(msg.customTools) ? (msg.customTools as CustomToolDefinition[]) : [];
        const problems: string[] = [];
        if (list.length > MAX_TOOLS_PER_CALL) problems.push("customTools: more than 8");
        const seen = new Set<string>();
        list.forEach((t, i) => {
          const nameErr = validateToolName(t.name);
          if (nameErr) problems.push(`customTools[${i}].name: ${nameErr}`);
          if (seen.has(t.name)) problems.push(`customTools[${i}].name: duplicate`);
          seen.add(t.name);
          if (!t.description || t.description.length > 1024) problems.push(`customTools[${i}].description`);
          if (!/^https:\/\//.test(t.url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(t.url)) problems.push(`customTools[${i}].url`);
          if (Object.keys(t.headers ?? {}).length > 10) problems.push(`customTools[${i}].headers`);
          problems.push(...validateAlebexSchema(t.parameters, `customTools[${i}].parameters`));
        });
        if (problems.length) {
          send({ type: "error", code: "invalid_config", message: problems[0] });
          ws.close(1008, "invalid config");
          return;
        }
        tools = list;
        rec.toolNames = list.map((t) => t.name);
        role = roleFromAgent(agentId);
        void token;
        enqueue(opening);
        return;
      }
      case "mark": {
        if (typeof msg.name === "string") rec.marksAcked.push(msg.name);
        return;
      }
      case "mock_user_utterance": {
        const text = typeof msg.text === "string" ? msg.text.slice(0, 400) : "";
        if (!text) return;
        if (speaking) {
          // Barge-in: stop talking and tell the client to flush queued audio.
          speaking.cancelled = true;
          speaking = null;
          send({ type: "clear_audio" });
        }
        enqueue(async () => {
          await hear(text);
          if (stage !== "done") await respond(text);
        });
        return;
      }
      case "end_call":
        rec.endCallReceived = true;
        ws.close(1000, "call ended");
        return;
      default:
        return;
    }
  });
  ws.on("close", () => {
    rec.closed = true;
    if (speaking) speaking.cancelled = true;
  });
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "GUARD-4821" → "GUARD 4 8 2 1" so it is read digit by digit. */
function spell(id: string): string {
  return id.replace(/-/g, " ").replace(/(\d)/g, " $1").replace(/\s+/g, " ").trim();
}
