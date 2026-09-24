/**
 * Alebex Voice Engine protocol probe (Node, never the browser).
 *
 *   pnpm probe:alebex                 # full probe if an agent ID is configured, else auth-only
 *   pnpm probe:alebex --auth-only     # handshake + start_call with a nonexistent agent (no conversation)
 *   pnpm probe:alebex --require-live  # exit non-zero instead of skipping when credentials are absent
 *
 * Records frame TYPES and FIELD SHAPES only. Never prints the token, raw audio
 * or transcript text. The spoken fixture is generated into the OS temp dir and
 * deleted afterwards.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import {
  ALEBEX_WS_URL,
  alebexSubprotocol,
  buildStartCall,
  describeShape,
  END_CALL_FRAME,
  FRAME_BYTES,
  floatToPcm16,
  int16ToLeBytes,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  parseServerObject,
  PlaybackTimeline,
} from "../packages/alebex-protocol/src/index";
import { resolveToken } from "../apps/gateway/src/env";
import { Store } from "../apps/gateway/src/store";

const ROOT = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const { token, source } = resolveToken(process.env);
const agentId =
  process.env.PROBE_AGENT_ID?.trim() ||
  process.env.ALEBEX_AGENT_SENTINEL_ID?.trim() ||
  process.env.ALEBEX_AGENT_DEFAULT_ID?.trim() ||
  process.env.ALEBEX_AGENT_TRUSTLINE_ID?.trim() ||
  process.env.ALEBEX_AGENT_RECOVERY_ID?.trim() ||
  "";
const url = process.env.ALEBEX_WS_URL?.trim() || ALEBEX_WS_URL;
const authOnly = args.has("--auth-only") || !agentId;
const PROBE_FAKE_AGENT = "guardian-probe-nonexistent-agent";

interface Report {
  status: "pass" | "fail" | "skipped";
  mode: "full" | "auth-only" | "none";
  at: string;
  tokenEnvName: string | null;
  endpoint: string;
  handshake: { ok: boolean; httpStatus?: number; reason?: string; subprotocolEchoed?: string | null; latencyMs?: number };
  frames: Record<string, number>;
  shapes: Record<string, unknown[]>;
  binaryFrames: { count: number; sizes: number[] };
  agentAudio: { bytes: number; secondsAt24k: number; encodings: string[] };
  marks: { received: number; echoed: number; flushedByClear: number };
  /** Values of fields that are enumerations, never content: safe to record. */
  enumValues: Record<string, string[]>;
  close: { code?: number; reason?: string };
  notes: string[];
  summary: string;
}

const report: Report = {
  status: "fail",
  mode: authOnly ? "auth-only" : "full",
  at: new Date().toISOString(),
  tokenEnvName: source,
  endpoint: url,
  handshake: { ok: false },
  frames: {},
  shapes: {},
  binaryFrames: { count: 0, sizes: [] },
  agentAudio: { bytes: 0, secondsAt24k: 0, encodings: [] },
  marks: { received: 0, echoed: 0, flushedByClear: 0 },
  enumValues: {},
  close: {},
  notes: [],
  summary: "",
};

function log(line: string): void {
  // Belt and braces: never let the token reach stdout.
  process.stdout.write(`${token ? line.split(token).join("[token]") : line}\n`);
}

function persist(): void {
  mkdirSync(join(ROOT, "docs", "probe"), { recursive: true });
  writeFileSync(join(ROOT, "docs", "probe", "last-probe.json"), `${JSON.stringify(report, null, 2)}\n`);
  try {
    const dbPath = (process.env.DATABASE_URL ?? "file:./data/guardian.db").replace(/^file:/, "");
    const store = new Store(resolve(ROOT, "apps", "gateway", dbPath));
    store.setKv("last_probe", JSON.stringify({ status: report.status === "skipped" ? "not_run" : report.status, at: report.at, summary: report.summary }));
    store.close();
  } catch {
    /* diagnostics DB is optional */
  }
}

function makeFixture(): { pcm: Buffer; source: string } {
  const phrase = "I received a suspicious bank call and I need help.";
  const dir = mkdtempSync(join(tmpdir(), "guardian-probe-"));
  try {
    const aiff = join(dir, "p.aiff");
    const raw = join(dir, "p.pcm");
    execFileSync("say", ["-o", aiff, phrase], { stdio: "ignore" });
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", aiff, "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(INPUT_SAMPLE_RATE), raw], { stdio: "ignore" });
    return { pcm: readFileSync(raw), source: "macOS say + ffmpeg (synthetic phrase, not personal data)" };
  } catch {
    const n = INPUT_SAMPLE_RATE * 2;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / INPUT_SAMPLE_RATE);
    return { pcm: Buffer.from(int16ToLeBytes(floatToPcm16(f))), source: "synthetic tone (say/ffmpeg unavailable)" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ENUM_FIELDS = ["format", "sample_rate", "sampleRate", "role", "speaker", "code", "final", "is_final", "isFinal", "status", "encoding", "channels"];

function recordShape(type: string, raw: Record<string, unknown>): void {
  report.frames[type] = (report.frames[type] ?? 0) + 1;
  for (const f of ENUM_FIELDS) {
    const v = raw[f];
    if (v === undefined || (typeof v === "string" && v.length > 24) || (typeof v === "object" && v !== null)) continue;
    const key = `${type}.${f}`;
    const list = (report.enumValues[key] ??= []);
    if (!list.includes(String(v)) && list.length < 6) list.push(String(v));
  }
  const list = (report.shapes[type] ??= []);
  if (list.length < 2) list.push(describeShape(raw));
}

async function run(): Promise<number> {
  if (!token) {
    report.status = "skipped";
    report.mode = "none";
    report.summary = "Skipped: no Alebex token in ALEBEX_API_KEY / ALEBEX_VOICE_TOKEN / ALEB_API_KEY.";
    log(`[probe] ${report.summary}`);
    persist();
    return args.has("--require-live") ? 2 : 0;
  }
  log(`[probe] endpoint ${url}`);
  log(`[probe] token from ${source} (value not shown)`);
  log(authOnly ? `[probe] mode: auth-only (no agent ID configured; start_call uses a deliberately nonexistent agent)` : `[probe] mode: full (agent ID configured)`);

  const fixture = authOnly ? null : makeFixture();
  if (fixture) report.notes.push(`Input fixture: ${fixture.source}, ${fixture.pcm.byteLength} bytes PCM16LE 16 kHz mono.`);

  const t0 = Date.now();
  const ws = new WebSocket(url, [alebexSubprotocol(token)], { handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024 });
  const timeline = new PlaybackTimeline<Record<string, unknown>>();
  const clock = () => (Date.now() - t0) / 1000;
  let sawAudio = false;
  let sawText = false;
  let sawError: string | null = null;
  let ended = false;
  let agentTurns = 0;
  let endSentAt = 0;

  const done = new Promise<void>((resolveDone) => {
    ws.on("unexpected-response", (_req, res) => {
      report.handshake = { ok: false, httpStatus: res.statusCode ?? 0, reason: res.statusMessage ?? "", latencyMs: Date.now() - t0 };
      log(`[probe] handshake refused: HTTP ${res.statusCode} ${res.statusMessage ?? ""}`);
      ws.terminate();
      resolveDone();
    });
    ws.on("error", (err) => {
      if (!report.handshake.httpStatus) report.notes.push(`socket error: ${err.message.replace(token, "[token]")}`);
      resolveDone();
    });
    ws.on("close", (code, reason) => {
      report.close = { code, reason: reason.toString("utf8").slice(0, 120) };
      if (endSentAt) report.notes.push(`Socket closed ${Date.now() - endSentAt} ms after end_call.`);
      log(`[probe] closed ${code} ${report.close.reason ?? ""}`);
      resolveDone();
    });
  });

  ws.on("open", () => {
    report.handshake = { ok: true, subprotocolEchoed: ws.protocol ? (ws.protocol === alebexSubprotocol(token) ? "alebex.token.[token]" : "other") : null, latencyMs: Date.now() - t0 };
    log(`[probe] handshake ok in ${report.handshake.latencyMs} ms (server echoed subprotocol: ${report.handshake.subprotocolEchoed ?? "none"})`);
    const start = buildStartCall(authOnly ? PROBE_FAKE_AGENT : agentId, []);
    ws.send(JSON.stringify(start));
    log(`[probe] sent start_call (agent ${authOnly ? "nonexistent probe id" : "configured"}, no customTools)`);
    if (fixture) void streamFixture(ws, fixture.pcm);
    else setTimeout(() => ws.readyState === WebSocket.OPEN && ws.close(1000), 6_000);
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = data as Buffer;
      report.binaryFrames.count++;
      if (report.binaryFrames.sizes.length < 10) report.binaryFrames.sizes.push(buf.byteLength);
      report.agentAudio.bytes += buf.byteLength;
      if (!report.agentAudio.encodings.includes("binary")) report.agentAudio.encodings.push("binary");
      timeline.enqueue(buf.byteLength / 2 / OUTPUT_SAMPLE_RATE, clock());
      sawAudio = true;
      return;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      recordShape("(non-json text)", {});
      return;
    }
    const type = typeof obj.type === "string" ? obj.type : "(no type)";
    recordShape(type, obj);
    const ev = parseServerObject(obj);
    switch (ev.kind) {
      case "audio":
        sawAudio = true;
        report.agentAudio.bytes += ev.pcm.byteLength;
        if (!report.agentAudio.encodings.includes(ev.variant)) report.agentAudio.encodings.push(ev.variant);
        timeline.enqueue(ev.pcm.byteLength / 2 / (ev.sampleRate ?? OUTPUT_SAMPLE_RATE), clock());
        break;
      case "mark":
        report.marks.received++;
        timeline.addMark(ev.raw, clock());
        break;
      case "clear_audio":
        report.marks.flushedByClear += timeline.clear(clock()).droppedMarks.length;
        break;
      case "transcript":
        sawText = true;
        break;
      case "conversation_message":
        sawText = true;
        if (ev.role === "agent") agentTurns++;
        break;
      case "error":
        sawError = ev.code ?? "error";
        log(`[probe] error frame: code=${ev.code ?? "(none)"}`);
        break;
      case "unknown":
        report.notes.push(`Adapter did not recognise frame type "${type}": ${ev.reason}`);
        break;
      case "control":
        if (ev.type === "call_ended" && endSentAt) report.notes.push(`call_ended arrived ${Date.now() - endSentAt} ms after end_call.`);
        else if (ev.type === "call_ended") report.notes.push("call_ended arrived before end_call was sent (engine ended the call).");
        break;
      default:
        break;
    }
  });

  // Simulated playback: echo each mark verbatim only once the audio queued before it would have finished playing.
  const markTimer = setInterval(() => {
    for (const m of timeline.takeDueMarks(clock())) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(m));
        report.marks.echoed++;
      }
    }
  }, 50);

  // Turn-taking like a person: keep the mic open with silence, speak only after the
  // greeting has been heard (its mark echoed), then wait for the agent's reply.
  async function streamFixture(sock: WebSocket, pcm: Buffer): Promise<void> {
    const silence = Buffer.alloc(FRAME_BYTES);
    const frames: Buffer[] = [];
    for (let o = 0; o < pcm.byteLength; o += FRAME_BYTES) {
      const f = Buffer.alloc(FRAME_BYTES);
      pcm.copy(f, 0, o, Math.min(pcm.byteLength, o + FRAME_BYTES));
      frames.push(f);
    }
    const open = () => sock.readyState === WebSocket.OPEN && !ended;
    const tick = () => new Promise((r) => setTimeout(r, 200));
    let waited = 0;
    while (open() && report.marks.echoed === 0 && waited < 75) {
      sock.send(silence, { binary: true });
      await tick();
      waited++;
    }
    const agentTurnsBefore = agentTurns;
    report.notes.push(`Spoke after ${(waited * 0.2).toFixed(1)} s of silence (${report.marks.echoed > 0 ? "greeting mark echoed first" : "no greeting mark seen"}).`);
    for (const f of frames) {
      if (!open()) return;
      sock.send(f, { binary: true });
      await tick();
    }
    waited = 0;
    while (open() && waited < 100 && !(agentTurns > agentTurnsBefore && !timeline.isPlaying(clock()))) {
      sock.send(silence, { binary: true });
      await tick();
      waited++;
    }
    report.notes.push(agentTurns > agentTurnsBefore ? `Agent replied within ${(waited * 0.2).toFixed(1)} s of the phrase ending.` : "No agent reply observed after the phrase.");
    if (sock.readyState === WebSocket.OPEN) {
      ended = true;
      endSentAt = Date.now();
      sock.send(JSON.stringify(END_CALL_FRAME));
      log("[probe] sent end_call");
      setTimeout(() => sock.readyState !== WebSocket.CLOSED && sock.terminate(), 5_000);
    }
  }

  const hardStop = setTimeout(() => ws.terminate(), authOnly ? 15_000 : 70_000);
  await done;
  clearTimeout(hardStop);
  clearInterval(markTimer);
  report.agentAudio.secondsAt24k = Math.round((report.agentAudio.bytes / 2 / OUTPUT_SAMPLE_RATE) * 10) / 10;

  if (authOnly) {
    // Pass = the token was accepted at the handshake and the engine answered the bad agent with a documented refusal.
    const accepted = report.handshake.ok;
    report.status = accepted ? "pass" : "fail";
    report.summary = accepted
      ? `Auth-only probe: token accepted; start_call with a nonexistent agent → ${sawError ? `error frame code "${sawError}"` : "no error frame"}, close ${report.close.code ?? "?"}. Audio/mark/transcript shapes NOT confirmed (no agent ID configured).`
      : `Auth-only probe failed: handshake ${report.handshake.httpStatus ? `HTTP ${report.handshake.httpStatus} ${report.handshake.reason}` : "did not complete"}.`;
  } else {
    const ok = report.handshake.ok && sawAudio && sawText && !sawError;
    report.status = ok ? "pass" : "fail";
    report.summary = ok
      ? `Full probe passed: ${Object.entries(report.frames).map(([k, v]) => `${k}×${v}`).join(", ")}; ${report.binaryFrames.count} binary frames; ${report.marks.echoed}/${report.marks.received} marks echoed after simulated playback.`
      : `Full probe failed: handshake=${report.handshake.ok} audio=${sawAudio} text=${sawText} error=${sawError ?? "none"}.`;
  }
  log(`[probe] ${report.status.toUpperCase()}: ${report.summary}`);
  log(`[probe] frame shapes written to docs/probe/last-probe.json`);
  persist();
  return report.status === "pass" ? 0 : 1;
}

run().then(
  (code) => process.exit(code),
  (err: unknown) => {
    report.status = "fail";
    report.summary = `Probe crashed: ${String(err).replace(token ?? "\u0000", "[token]")}`;
    log(`[probe] ${report.summary}`);
    persist();
    process.exit(1);
  },
);
