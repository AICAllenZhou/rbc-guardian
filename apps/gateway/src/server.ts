import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { CreateSessionRequestSchema, DISCLAIMER, TOOL_NAMES, type ToolName } from "@guardian/shared";
import type { GatewayConfig } from "./env";
import { Store } from "./store";
import { EventBus } from "./events";
import { CaseError, CaseService } from "./cases";
import { Diagnostics } from "./diagnostics";
import { createLogger, type Logger } from "./logger";
import { ToolService } from "./tools/handlers";
import { SessionManager } from "./voice/manager";
import type { SessionLimits } from "./voice/session";
import { startMockAlebex, type MockAlebex, type MockAlebexOptions } from "./mock/mock-alebex";

export const TICKET_SUBPROTOCOL_PREFIX = "guardian.ticket.";

export interface GatewayApp {
  app: FastifyInstance;
  store: Store;
  cases: CaseService;
  tools: ToolService;
  sessions: SessionManager;
  diag: Diagnostics;
  mock: MockAlebex | null;
  close(): Promise<void>;
}

export interface BuildOptions {
  logger?: Logger;
  mock?: MockAlebexOptions;
  limits?: Partial<SessionLimits>;
}

const OperatorActionSchema = z.object({
  tool: z.enum(["record_customer_response", "temporary_card_lock", "flag_suspicious_transaction", "request_human_review", "issue_reverse_auth_phrase"]),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export async function buildGateway(cfg: GatewayConfig, opts: BuildOptions = {}): Promise<GatewayApp> {
  const log = opts.logger ?? createLogger();
  const store = new Store(cfg.databasePath);
  const bus = new EventBus();
  const cases = new CaseService(store, bus);
  cases.ensureSeed();
  const diag = new Diagnostics();
  const tools = new ToolService(store, cases, cfg.signingSecret, log);
  const mock = cfg.mode === "mock" ? await startMockAlebex(opts.mock) : null;
  const sessions = new SessionManager({ cfg, store, cases, diag, log, ...(mock ? { mockUpstreamUrl: mock.url } : {}), ...(opts.limits ? { limits: opts.limits } : {}) });

  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || origin === cfg.appOrigin || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)),
    methods: ["GET", "POST"],
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof CaseError) return reply.status(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) log.error("http.error", { error: String(err) });
    return reply.status(status).send({ error: status >= 500 ? "Internal error" : (err as Error).message });
  });

  app.get("/health", async () => ({ ok: true, mode: cfg.mode, disclaimer: DISCLAIMER }));
  app.get("/api/readiness", async () => diag.readiness(cfg, store));

  app.post("/api/demo/reset", async () => {
    await sessions.drain("demo-reset");
    cases.resetDemo();
    return { ok: true };
  });
  app.post("/api/demo/detect", async () => ({ case: cases.detect() }));
  app.get("/api/cases", async () => ({ cases: store.listCases() }));
  app.get<{ Params: { id: string } }>("/api/cases/:id", async (req) => cases.view(req.params.id));
  app.get<{ Params: { id: string } }>("/api/cases/:id/summary", async (req, reply) => {
    const v = cases.view(req.params.id);
    reply.header("Content-Disposition", `attachment; filename="${v.case.id}-summary.json"`);
    return { disclaimer: DISCLAIMER, generatedAt: new Date().toISOString(), ...v };
  });

  app.post<{ Params: { id: string } }>("/api/cases/:id/operator", async (req, reply) => {
    const parsed = OperatorActionSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid operator action." });
    cases.require(req.params.id);
    const r = await tools.run(parsed.data.tool, parsed.data.arguments, { role: "operator", sessionId: null, caseId: req.params.id, callId: `operator-${req.params.id}` });
    const c = store.getCase(req.params.id);
    if (c) cases.event(c, null, "operator_action", `Operator action: ${parsed.data.tool}`, "Applied from the demo control room (not by a voice agent).", "Demo operator");
    return reply.status(r.status).send(r.body);
  });

  app.post("/api/sessions", async (req, reply) => {
    const parsed = CreateSessionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Unknown agent role or case ID." });
    return reply.status(201).send(sessions.create(parsed.data.role, parsed.data.caseId));
  });

  // Custom Tool endpoint called by Alebex (or the mock engine).
  app.post<{ Params: { tool: string }; Querystring: Record<string, unknown> }>("/tools/:tool", async (req, reply) => {
    const r = await tools.handleHttp(req.params.tool, req.headers, req.query, req.body);
    return reply.status(r.status).send(r.body);
  });

  // Server-sent events for the live case timeline.
  app.get<{ Querystring: { caseId?: string } }>("/api/events", (req, reply) => {
    const caseId = req.query.caseId && /^GUARD-\d{4}$|^\*$/.test(req.query.caseId) ? req.query.caseId : "*";
    const origin = req.headers.origin;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    });
    reply.raw.write(`retry: 2000\n\n`);
    const unsub = bus.subscribe(caseId, (msg) => reply.raw.write(`event: ${msg.kind}\ndata: ${JSON.stringify(msg)}\n\n`));
    const keepAlive = setInterval(() => reply.raw.write(`: keep-alive\n\n`), 15_000);
    req.raw.on("close", () => {
      clearInterval(keepAlive);
      unsub();
    });
  });

  // Browser voice socket. The one-time ticket travels as a subprotocol so it never appears in URLs or access logs.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    handleProtocols: (protocols) => {
      for (const p of protocols) if (p.startsWith(TICKET_SUBPROTOCOL_PREFIX)) return p;
      return false;
    },
  });
  app.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== "/voice") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== cfg.appOrigin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
    const ticket = protocols.find((p) => p.startsWith(TICKET_SUBPROTOCOL_PREFIX))?.slice(TICKET_SUBPROTOCOL_PREFIX.length) ?? "";
    const sid = url.searchParams.get("sid") ?? "";
    wss.handleUpgrade(req, socket, head, (ws) => {
      const failure = sessions.attach(ws, sid, ticket);
      if (failure !== null) {
        log.warn("voice.attach_rejected", { sessionId: sid, code: failure });
        ws.close(failure, "session rejected");
      }
    });
  });

  return {
    app,
    store,
    cases,
    tools,
    sessions,
    diag,
    mock,
    async close() {
      // Order matters: finish calls (they write their end state), then stop serving, then close storage.
      await sessions.drain("gateway-shutdown");
      for (const c of wss.clients) c.terminate();
      wss.close();
      await mock?.close();
      await app.close();
      store.close();
    },
  };
}

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}
