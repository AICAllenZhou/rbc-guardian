/**
 * SQLite persistence via Node's built-in `node:sqlite` (no native addon to build).
 * Entities are stored as JSON documents keyed by id with a few indexed columns;
 * all SQL lives in this file.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CaseEvent,
  CustomerProfile,
  GuardianCase,
  ToolInvocationRecord,
  Transaction,
  VoiceSessionRecord,
} from "@guardian/shared";

export interface StoredMessage {
  id: string;
  sessionId: string;
  caseId: string;
  role: "user" | "agent";
  text: string;
  at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, case_id TEXT NOT NULL, at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_invocations (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, at TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS case_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, case_id TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, tool TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_events_case ON case_events(case_id, seq);
      CREATE INDEX IF NOT EXISTS idx_tools_case ON tool_invocations(case_id, at);
      CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id, at);
    `);
  }

  close(): void {
    this.db.close();
  }

  resetAll(): void {
    this.db.exec(`DELETE FROM customers; DELETE FROM transactions; DELETE FROM cases; DELETE FROM sessions;
      DELETE FROM messages; DELETE FROM tool_invocations; DELETE FROM case_events; DELETE FROM idempotency;`);
  }

  private getDoc<T>(table: string, id: string): T | null {
    const row = this.db.prepare(`SELECT doc FROM ${table} WHERE id = ?`).get(id) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as T) : null;
  }

  putCustomer(c: CustomerProfile): void {
    this.db.prepare("INSERT OR REPLACE INTO customers (id, doc) VALUES (?, ?)").run(c.id, JSON.stringify(c));
  }
  getCustomer(id: string): CustomerProfile | null {
    return this.getDoc("customers", id);
  }

  putTransaction(t: Transaction): void {
    this.db.prepare("INSERT OR REPLACE INTO transactions (id, customer_id, at, doc) VALUES (?, ?, ?, ?)").run(t.id, t.customerId, t.at, JSON.stringify(t));
  }
  getTransaction(id: string): Transaction | null {
    return this.getDoc("transactions", id);
  }
  listTransactions(customerId: string, limit: number): Transaction[] {
    const rows = this.db.prepare("SELECT doc FROM transactions WHERE customer_id = ? ORDER BY at DESC LIMIT ?").all(customerId, limit) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Transaction);
  }

  putCase(c: GuardianCase): void {
    this.db.prepare("INSERT OR REPLACE INTO cases (id, updated_at, doc) VALUES (?, ?, ?)").run(c.id, c.updatedAt, JSON.stringify(c));
  }
  getCase(id: string): GuardianCase | null {
    return this.getDoc("cases", id);
  }
  listCases(): GuardianCase[] {
    const rows = this.db.prepare("SELECT doc FROM cases ORDER BY updated_at DESC").all() as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as GuardianCase);
  }

  putSession(s: VoiceSessionRecord): void {
    this.db.prepare("INSERT OR REPLACE INTO sessions (id, case_id, doc) VALUES (?, ?, ?)").run(s.id, s.caseId, JSON.stringify(s));
  }
  getSession(id: string): VoiceSessionRecord | null {
    return this.getDoc("sessions", id);
  }
  listSessions(caseId: string): VoiceSessionRecord[] {
    const rows = this.db.prepare("SELECT doc FROM sessions WHERE case_id = ?").all(caseId) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as VoiceSessionRecord).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  addMessage(m: Omit<StoredMessage, "id">): StoredMessage {
    const msg = { id: randomUUID(), ...m };
    this.db.prepare("INSERT INTO messages (id, session_id, case_id, at, doc) VALUES (?, ?, ?, ?, ?)").run(msg.id, m.sessionId, m.caseId, m.at, JSON.stringify(msg));
    return msg;
  }
  listMessages(caseId: string): StoredMessage[] {
    const rows = this.db.prepare("SELECT doc FROM messages WHERE case_id = ? ORDER BY at, rowid").all(caseId) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as StoredMessage);
  }

  addToolInvocation(t: ToolInvocationRecord): void {
    this.db.prepare("INSERT INTO tool_invocations (id, case_id, at, doc) VALUES (?, ?, ?, ?)").run(t.id, t.caseId, t.at, JSON.stringify(t));
  }
  listToolInvocations(caseId: string): ToolInvocationRecord[] {
    const rows = this.db.prepare("SELECT doc FROM tool_invocations WHERE case_id = ? ORDER BY at, rowid").all(caseId) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as ToolInvocationRecord);
  }

  addEvent(e: CaseEvent): void {
    this.db.prepare("INSERT INTO case_events (id, case_id, doc) VALUES (?, ?, ?)").run(e.id, e.caseId, JSON.stringify(e));
  }
  listEvents(caseId: string): CaseEvent[] {
    const rows = this.db.prepare("SELECT doc FROM case_events WHERE case_id = ? ORDER BY seq").all(caseId) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as CaseEvent);
  }

  getIdempotent(key: string): { status: number; body: unknown } | null {
    const row = this.db.prepare("SELECT status, body FROM idempotency WHERE key = ?").get(key) as { status: number; body: string } | undefined;
    return row ? { status: row.status, body: JSON.parse(row.body) } : null;
  }
  putIdempotent(key: string, tool: string, status: number, body: unknown): void {
    this.db.prepare("INSERT OR IGNORE INTO idempotency (key, tool, status, body, at) VALUES (?, ?, ?, ?, ?)").run(key, tool, status, JSON.stringify(body), new Date().toISOString());
  }

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setKv(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  }
}
