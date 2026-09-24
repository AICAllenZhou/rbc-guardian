import { WebSocket } from "ws";
import type { CreateSessionResponse, ServerMessage } from "@guardian/shared";
import { loadConfig, type GatewayConfig } from "../../src/env";
import { buildGateway, TICKET_SUBPROTOCOL_PREFIX, type GatewayApp } from "../../src/server";
import { createLogger } from "../../src/logger";
import type { MockAlebexOptions } from "../../src/mock/mock-alebex";
import type { SessionLimits } from "../../src/voice/session";

export interface TestGateway {
  gw: GatewayApp;
  cfg: GatewayConfig;
  base: string;
  wsBase: string;
  close(): Promise<void>;
}

export async function startGateway(env: Record<string, string> = {}, opts: { mock?: MockAlebexOptions; limits?: Partial<SessionLimits> } = {}): Promise<TestGateway> {
  const cfg = loadConfig({ ALEBEX_MODE: "mock", DATABASE_URL: ":memory:", TOOL_SIGNING_SECRET: "t".repeat(40), ...env });
  const gw = await buildGateway(cfg, { logger: createLogger({ silent: true }), mock: { pace: 0, ...opts.mock }, limits: { activateAfterMs: 50, endGraceMs: 300, ...opts.limits } });
  await gw.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = gw.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  cfg.gatewayOrigin = `http://127.0.0.1:${port}`;
  const base = cfg.gatewayOrigin;
  return { gw, cfg, base, wsBase: `ws://127.0.0.1:${port}`, close: () => gw.close() };
}

export async function post<T = Record<string, unknown>>(base: string, path: string, body: unknown = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

export class BrowserClient {
  readonly messages: ServerMessage[] = [];
  readonly binary: Buffer[] = [];
  closeCode: number | null = null;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  private closeWaiters: ((code: number) => void)[] = [];

  constructor(
    readonly ws: WebSocket,
    readonly autoAckMarks: boolean,
  ) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.binary.push(data as Buffer);
        return;
      }
      const m = JSON.parse(String(data)) as ServerMessage;
      this.messages.push(m);
      if (m.type === "mark" && this.autoAckMarks) ws.send(JSON.stringify({ type: "mark_played", mark: m.mark }));
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
    ws.on("close", (code) => {
      this.closeCode = code;
      for (const w of this.closeWaiters) w(code);
    });
  }

  waitFor<T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = 10_000): Promise<Extract<ServerMessage, { type: T }>> {
    const existing = this.messages.find((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
    if (existing) return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}; got ${this.messages.map((m) => m.type).join(",")}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>),
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  /** Wait for the next hint that arrives after `afterCount` hints. */
  async nextHint(afterCount: number): Promise<string[]> {
    for (let i = 0; i < 200; i++) {
      const hints = this.messages.filter((m) => m.type === "hint");
      if (hints.length > afterCount) return (hints[afterCount] as Extract<ServerMessage, { type: "hint" }>).replies;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no hint");
  }

  get hintCount(): number {
    return this.messages.filter((m) => m.type === "hint").length;
  }

  say(text: string): void {
    this.ws.send(JSON.stringify({ type: "mock_utterance", text }));
  }

  waitClose(timeoutMs = 10_000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not close")), timeoutMs);
      this.closeWaiters.push((c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
  }
}

export async function openCall(t: TestGateway, role: "sentinel" | "trustline" | "recovery", opts: { autoAckMarks?: boolean; caseId?: string } = {}): Promise<{ client: BrowserClient; session: CreateSessionResponse }> {
  const res = await post<CreateSessionResponse>(t.base, "/api/sessions", { role, ...(opts.caseId ? { caseId: opts.caseId } : {}) });
  if (res.status !== 201) throw new Error(`session create failed: ${res.status} ${JSON.stringify(res.body)}`);
  const client = await connect(t, res.body.wsPath, res.body.ticket, opts.autoAckMarks ?? true);
  return { client, session: res.body };
}

export function connect(t: TestGateway, wsPath: string, ticket: string, autoAckMarks = true): Promise<BrowserClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${t.wsBase}${wsPath}`, [`${TICKET_SUBPROTOCOL_PREFIX}${ticket}`], { origin: "http://localhost:3000" });
    const client = new BrowserClient(ws, autoAckMarks);
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
