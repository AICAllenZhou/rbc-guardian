"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TranscriptStore, type TranscriptEntry } from "@guardian/alebex-protocol";
import type { AgentRole, CreateSessionResponse, ServerMessage, SessionState } from "@guardian/shared";
import { api, GATEWAY_WS_URL, GatewayError, TICKET_SUBPROTOCOL_PREFIX } from "../gateway";
import { MicError, startMic, type MicHandle } from "./mic";
import { PcmPlayer } from "./player";

export type CallPhase = "idle" | "requesting" | SessionState;
export type MicState = "off" | "starting" | "live" | "muted" | "unavailable";

export interface CallError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface VoiceCall {
  phase: CallPhase;
  session: CreateSessionResponse | null;
  messages: readonly TranscriptEntry[];
  drafts: TranscriptEntry[];
  hints: string[];
  error: CallError | null;
  mic: MicState;
  micNote: string | null;
  micLevel: number;
  agentLevel: number;
  muted: boolean;
  lastEndReason: string | null;
  start(role: AgentRole, caseId?: string): Promise<void>;
  end(): void;
  toggleMute(): void;
  sendMockUtterance(text: string): void;
  dismissError(): void;
}

/** One active call per browser tab. */
let tabCallActive = false;

export function useVoiceCall(): VoiceCall {
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [session, setSession] = useState<CreateSessionResponse | null>(null);
  const [messages, setMessages] = useState<readonly TranscriptEntry[]>([]);
  const [drafts, setDrafts] = useState<TranscriptEntry[]>([]);
  const [hints, setHints] = useState<string[]>([]);
  const [error, setError] = useState<CallError | null>(null);
  const [mic, setMic] = useState<MicState>("off");
  const [micNote, setMicNote] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [agentLevel, setAgentLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [lastEndReason, setLastEndReason] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicHandle | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const transcriptRef = useRef(new TranscriptStore());
  const mutedRef = useRef(false);
  const ownsLockRef = useRef(false);

  const syncTranscript = useCallback(() => {
    const t = transcriptRef.current;
    setMessages([...t.messages]);
    setDrafts(t.liveDrafts);
  }, []);

  /**
   * Release everything this call holds. References and the tab lock are released
   * synchronously so a new call can start at once; the old player may keep
   * draining its last words in the background.
   */
  const teardown = useCallback(async (drainPlayback: boolean) => {
    const ws = wsRef.current;
    const m = micRef.current;
    const p = playerRef.current;
    wsRef.current = null;
    micRef.current = null;
    playerRef.current = null;
    if (ownsLockRef.current) {
      tabCallActive = false;
      ownsLockRef.current = false;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000, "client teardown");
    setMic((s) => (s === "unavailable" ? s : "off"));
    setMicLevel(0);
    await m?.stop();
    if (p) {
      if (drainPlayback) {
        const deadline = Date.now() + 4_000;
        while (p.isPlaying() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      }
      await p.close();
    }
    if (!playerRef.current) setAgentLevel(0);
  }, []);

  const handleServer = useCallback(
    (msg: ServerMessage) => {
      const t = transcriptRef.current;
      switch (msg.type) {
        case "state":
          setPhase(msg.state);
          return;
        case "transcript":
          if (msg.final) t.final(msg.role, msg.text);
          else t.partial(msg.role, msg.text);
          syncTranscript();
          return;
        case "message":
          t.commit(msg.role, msg.text, msg.id);
          syncTranscript();
          return;
        case "mark":
          playerRef.current?.addMark(msg.mark);
          return;
        case "clear_audio":
          playerRef.current?.clear();
          return;
        case "audio_format":
          playerRef.current?.setSampleRate(msg.sampleRate);
          return;
        case "hint":
          setHints(msg.replies);
          return;
        case "error":
          setError({ code: msg.code, message: msg.message, recoverable: msg.recoverable });
          return;
        case "ended":
          setLastEndReason(msg.reason);
          setPhase("ended");
          setHints([]);
          void teardown(true);
          return;
        case "pong":
          return;
      }
    },
    [syncTranscript, teardown],
  );

  const start = useCallback(
    async (role: AgentRole, caseId?: string) => {
      if (tabCallActive) {
        setError({ code: "busy", message: "A Guardian call is already active in this tab. End it first.", recoverable: true });
        return;
      }
      tabCallActive = true;
      ownsLockRef.current = true;
      setSession(null);
      transcriptRef.current = new TranscriptStore();
      syncTranscript();
      setHints([]);
      setError(null);
      setLastEndReason(null);
      setMicNote(null);
      setPhase("requesting");

      // The player must be created inside the click handler so browsers allow audio.
      const player = new PcmPlayer(
        (mark) => {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "mark_played", mark }));
        },
        (level) => {
          if (playerRef.current === player) setAgentLevel(level);
        },
      );
      playerRef.current = player;
      void player.resume();

      let s: CreateSessionResponse;
      try {
        s = await api.createSession(role, caseId);
      } catch (err) {
        setError({ code: "session", message: err instanceof GatewayError ? err.message : "Could not start the call.", recoverable: true });
        setPhase("idle");
        await teardown(false);
        return;
      }
      setSession(s);

      // Microphone. Mock mode stays usable without one (reply chips stand in for speech).
      setMic("starting");
      let micHandle: MicHandle | null = null;
      try {
        micHandle = await startMic(
          (frame) => {
            const ws = wsRef.current;
            // Backpressure: skip frames rather than build up latency if the socket is congested.
            if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(frame);
          },
          (level) => setMicLevel(level),
        );
        micRef.current = micHandle;
        micHandle.setMuted(mutedRef.current);
        setMic(mutedRef.current ? "muted" : "live");
      } catch (err) {
        const message = err instanceof MicError ? err.message : "The microphone could not be started.";
        if (s.mode !== "mock") {
          setError({ code: err instanceof MicError ? `mic_${err.code}` : "mic_failed", message, recoverable: true });
          setMic("unavailable");
          setPhase("idle");
          await teardown(false);
          return;
        }
        setMic("unavailable");
        setMicNote(`${message} The mock runtime will continue with suggested replies.`);
      }

      const ws = new WebSocket(`${GATEWAY_WS_URL}${s.wsPath}`, [`${TICKET_SUBPROTOCOL_PREFIX}${s.ticket}`]);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onmessage = (e) => {
        if (wsRef.current !== ws) return; // late frames from a finished call are ignored
        if (e.data instanceof ArrayBuffer) {
          playerRef.current?.enqueue(e.data);
          return;
        }
        try {
          handleServer(JSON.parse(String(e.data)) as ServerMessage);
        } catch {}
      };
      ws.onclose = (e) => {
        if (wsRef.current !== ws) return;
        if (e.code !== 1000) {
          setError((prev) => prev ?? { code: `closed_${e.code}`, message: closeMessage(e.code), recoverable: e.code !== 4403 && e.code !== 4422 });
          setPhase("ended");
        }
        void teardown(true);
      };
      ws.onerror = () => {
        setError((prev) => prev ?? { code: "socket", message: "Lost the connection to the Guardian gateway.", recoverable: true });
      };
    },
    [handleServer, syncTranscript, teardown],
  );

  const end = useCallback(() => {
    const ws = wsRef.current;
    playerRef.current?.clear();
    if (ws?.readyState === WebSocket.OPEN) {
      setPhase("ending");
      ws.send(JSON.stringify({ type: "end" }));
      // If the gateway does not confirm promptly, clean up anyway.
      setTimeout(() => {
        if (wsRef.current === ws) {
          setPhase("ended");
          void teardown(false);
        }
      }, 3_000);
    } else {
      setPhase("ended");
      void teardown(false);
    }
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    micRef.current?.setMuted(next);
    setMic((m) => (m === "live" || m === "muted" ? (next ? "muted" : "live") : m));
  }, []);

  const sendMockUtterance = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    setHints([]);
    ws.send(JSON.stringify({ type: "mock_utterance", text }));
  }, []);

  // Browsers suspend audio in background tabs; resume when the tab is visible again.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void playerRef.current?.resume();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Keep the socket warm so idle timeouts never close a quiet call.
  useEffect(() => {
    const id = setInterval(() => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 20_000);
    return () => clearInterval(id);
  }, []);

  useEffect(
    () => () => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "end" }));
      void teardown(false);
    },
    [teardown],
  );

  return {
    phase,
    session,
    messages,
    drafts,
    hints,
    error,
    mic,
    micNote,
    micLevel,
    agentLevel,
    muted,
    lastEndReason,
    start,
    end,
    toggleMute,
    sendMockUtterance,
    dismissError: () => setError(null),
  };
}

function closeMessage(code: number): string {
  switch (code) {
    case 4401:
      return "This call link has expired or was already used. Start a new call.";
    case 4403:
      return "Alebex refused the voice token. Check the gateway configuration.";
    case 4422:
      return "Alebex refused the call setup. Check the agent ID in Diagnostics.";
    case 4429:
      return "Alebex is at capacity. Wait a moment and call again.";
    case 4502:
      return "The voice connection dropped. Completed actions are saved; you can call again.";
    case 4408:
      return "The call reached its maximum length.";
    default:
      return "The call ended unexpectedly.";
  }
}
