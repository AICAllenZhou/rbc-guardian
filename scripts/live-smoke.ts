/**
 * Live smoke test of the full product path, without a browser:
 *   Node "browser" client → Guardian gateway (live mode, in-process) → Alebex Voice Engine
 *
 *   pnpm smoke:live [--role sentinel|trustline|recovery]
 *
 * Verifies: ticketed browser socket, start_call with the role's agent ID, mic frames
 * forwarded, agent audio delivered as binary PCM, marks echoed after simulated
 * playback, transcript/messages, clean end, and that nothing sent to the "browser"
 * contains the token or tool credentials. Prints shapes and counts only.
 * Custom Tools are exercised only when PUBLIC_TOOL_BASE_URL is set (otherwise voice-only).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { FRAME_BYTES, INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, PlaybackTimeline } from "../packages/alebex-protocol/src/index";
import type { AgentRole, CreateSessionResponse, ServerMessage } from "../packages/shared/src/index";
import { loadConfig } from "../apps/gateway/src/env";
import { buildGateway, TICKET_SUBPROTOCOL_PREFIX } from "../apps/gateway/src/server";
import { createLogger } from "../apps/gateway/src/logger";

const ROOT = resolve(import.meta.dirname, "..");
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));
const roleArg = process.argv.indexOf("--role");
const role = (roleArg > 0 ? process.argv[roleArg + 1] : "sentinel") as AgentRole;

function fixture(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "guardian-smoke-"));
  try {
    const phrase = role === "trustline" ? "Someone called me saying they were from the bank and asked for a code." : "Yes, it matches.";
    execFileSync("say", ["-o", join(dir, "p.aiff"), phrase], { stdio: "ignore" });
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", join(dir, "p.aiff"), "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(INPUT_SAMPLE_RATE), join(dir, "p.pcm")], { stdio: "ignore" });
    return readFileSync(join(dir, "p.pcm"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const cfg = loadConfig({ ...process.env, ALEBEX_MODE: "live", DATABASE_URL: ":memory:" });
  if (cfg.errors.length) {
    console.log(`[smoke] SKIPPED: ${cfg.errors.join(" ")}`);
    return 0;
  }
  const lines: string[] = [];
  const gw = await buildGateway(cfg, { logger: createLogger({ sink: (l) => lines.push(l) }) });
  await gw.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = gw.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[smoke] gateway live on ${base}, mode ${cfg.mode}, role ${role}`);

  const report = {
    at: new Date().toISOString(),
    role,
    mode: cfg.mode,
    states: [] as string[],
    counts: {} as Record<string, number>,
    binaryAudioBytes: 0,
    marksAcked: 0,
    messages: { user: 0, agent: 0 },
    userPartials: 0,
    errors: [] as string[],
    endReason: null as string | null,
    closeCode: null as number | null,
    secretLeak: false,
    stats: null as unknown,
    status: "fail" as "pass" | "fail",
  };

  try {
    if (role === "sentinel" || role === "recovery") await fetch(`${base}/api/demo/detect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const res = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
    const session = (await res.json()) as CreateSessionResponse;
    if (res.status !== 201) throw new Error(`session create failed: ${res.status}`);

    const ws = new WebSocket(`ws://127.0.0.1:${port}${session.wsPath}`, [`${TICKET_SUBPROTOCOL_PREFIX}${session.ticket}`], { origin: "http://localhost:3000" });
    ws.binaryType = "nodebuffer";
    const t0 = Date.now();
    const clock = () => (Date.now() - t0) / 1000;
    const timeline = new PlaybackTimeline<Record<string, unknown>>();
    let rate = OUTPUT_SAMPLE_RATE;
    const received: string[] = [];

    const closed = new Promise<void>((done) => {
      ws.on("close", (code) => {
        report.closeCode = code;
        done();
      });
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const b = data as Buffer;
        report.binaryAudioBytes += b.byteLength;
        timeline.enqueue(b.byteLength / 2 / rate, clock());
        return;
      }
      const text = String(data);
      received.push(text);
      const m = JSON.parse(text) as ServerMessage;
      report.counts[m.type] = (report.counts[m.type] ?? 0) + 1;
      if (m.type === "state") report.states.push(m.state);
      if (m.type === "audio_format") rate = m.sampleRate;
      if (m.type === "mark") timeline.addMark(m.mark, clock());
      if (m.type === "clear_audio") timeline.clear(clock());
      if (m.type === "message") report.messages[m.role]++;
      if (m.type === "transcript" && m.role === "user" && !m.final) report.userPartials++;
      if (m.type === "error") report.errors.push(m.code);
      if (m.type === "ended") report.endReason = m.reason;
    });
    await new Promise<void>((r, j) => {
      ws.once("open", () => r());
      ws.once("error", j);
    });
    const markTimer = setInterval(() => {
      for (const mark of timeline.takeDueMarks(clock())) {
        ws.send(JSON.stringify({ type: "mark_played", mark }));
        report.marksAcked++;
      }
    }, 50);

    const pcm = fixture();
    const silence = Buffer.alloc(FRAME_BYTES);
    const tick = () => new Promise((r) => setTimeout(r, 200));
    const open = () => ws.readyState === WebSocket.OPEN;
    // Wait for the greeting to be heard, then speak, then wait for the reply.
    for (let i = 0; i < 80 && open() && report.marksAcked === 0; i++) {
      ws.send(silence);
      await tick();
    }
    for (let o = 0; o < pcm.byteLength && open(); o += FRAME_BYTES) {
      const f = Buffer.alloc(FRAME_BYTES);
      pcm.copy(f, 0, o, Math.min(pcm.byteLength, o + FRAME_BYTES));
      ws.send(f);
      await tick();
    }
    const agentBefore = report.messages.agent;
    for (let i = 0; i < 100 && open() && !(report.messages.agent > agentBefore && !timeline.isPlaying(clock())); i++) {
      ws.send(silence);
      await tick();
    }
    ws.send(JSON.stringify({ type: "end" }));
    await Promise.race([closed, new Promise((r) => setTimeout(r, 8_000))]);
    clearInterval(markTimer);
    report.stats = gw.sessions.get(session.sessionId)?.stats ?? "finished";

    const token = cfg.alebexToken ?? "\u0000";
    const all = received.join("\n");
    report.secretLeak = all.includes(token) || all.includes(cfg.signingSecret) || /alebex\.token\.|X-Guardian-Session|Bearer /.test(all);
    const logLeak = lines.some((l) => l.includes(token));
    if (logLeak) report.errors.push("token appeared in gateway logs");

    const ok = report.states.includes("active") && report.binaryAudioBytes > 0 && report.marksAcked > 0 && report.messages.agent > 0 && report.endReason !== null && report.closeCode === 1000 && !report.secretLeak && report.errors.length === 0;
    report.status = ok ? "pass" : "fail";
  } catch (err) {
    report.errors.push(String(err));
  } finally {
    await gw.close();
  }

  mkdirSync(join(ROOT, "docs", "probe"), { recursive: true });
  writeFileSync(join(ROOT, "docs", "probe", `live-smoke-${role}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[smoke] ${report.status.toUpperCase()}: states ${report.states.join(" → ")}; ${Math.round((report.binaryAudioBytes / 2 / OUTPUT_SAMPLE_RATE) * 10) / 10}s agent audio; ${report.marksAcked} marks acked; messages user ${report.messages.user} / agent ${report.messages.agent}; user partials ${report.userPartials}; ended "${report.endReason}" close ${report.closeCode}; secret leak ${report.secretLeak}; errors [${report.errors.join(", ")}]`);
  return report.status === "pass" ? 0 : 1;
}

main().then((c) => process.exit(c), (e: unknown) => {
  console.error(`[smoke] crashed: ${String(e)}`);
  process.exit(1);
});
