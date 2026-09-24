/**
 * Browser ↔ Guardian gateway protocol. This is OUR protocol, not Alebex's:
 * the browser never sees Alebex frames verbatim except mark objects, which it
 * must echo back unchanged once they have been heard.
 */
import { z } from "zod";
import { AgentRoleSchema } from "./domain";
import type { AgentRole, RuntimeMode, SessionState } from "./domain";

export const CreateSessionRequestSchema = z.object({
  role: AgentRoleSchema,
  caseId: z.string().regex(/^GUARD-\d{4}$/).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export interface CreateSessionResponse {
  sessionId: string;
  ticket: string;
  caseId: string;
  role: AgentRole;
  agentName: string;
  mode: RuntimeMode;
  toolsEnabled: boolean;
  singleAgentFallback: boolean;
  wsPath: string;
  outputSampleRate: number;
  maxDurationSec: number;
}

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mark_played"), mark: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("end") }),
  z.object({ type: z.literal("ping") }),
  /** Mock runtime only: stands in for speech because the mock has no ASR. Ignored in live mode. */
  z.object({ type: z.literal("mock_utterance"), text: z.string().min(1).max(400) }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "state"; state: SessionState; detail?: string }
  | { type: "clear_audio" }
  | { type: "mark"; mark: Record<string, unknown> }
  | { type: "transcript"; role: "user" | "agent"; text: string; final: boolean }
  | { type: "message"; role: "user" | "agent"; text: string; id: string }
  | { type: "error"; code: string; message: string; recoverable: boolean }
  | { type: "ended"; reason: string }
  | { type: "pong" }
  /** Mock runtime only: suggested replies, because the mock has no speech recognition. */
  | { type: "hint"; replies: string[] };

export interface ReadinessReport {
  mode: RuntimeMode;
  voiceTokenConfigured: boolean;
  agents: Record<AgentRole, boolean>;
  singleAgentFallback: boolean;
  publicToolUrlConfigured: boolean;
  toolSigningSecretConfigured: boolean;
  gatewayConnected: boolean;
  lastProbe: { status: "pass" | "fail" | "not_run"; at: string | null; summary: string | null };
  warnings: string[];
  unknownFrames: { type: string; reason: string; shape: unknown; at: string }[];
}

/** Guardian-defined close codes on the browser socket (4000–4999 are application-reserved). */
export const CLOSE = {
  normal: 1000,
  badTicket: 4401,
  sessionBusy: 4409,
  upstreamAuth: 4403,
  upstreamConfig: 4422,
  upstreamCapacity: 4429,
  upstreamLost: 4502,
  timeout: 4408,
} as const;
