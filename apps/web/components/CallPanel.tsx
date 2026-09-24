"use client";

import { useEffect, useRef, useState } from "react";
import { AGENT_PERSONAS, redact, type AgentRole } from "@guardian/shared";
import type { VoiceCall } from "@/lib/voice/useVoiceCall";
import { ActivityBars } from "./CaseWidgets";

const PHASE_LABEL: Record<VoiceCall["phase"], string> = {
  idle: "Not connected",
  requesting: "Preparing call",
  connecting_upstream: "Connecting to voice engine",
  starting: "Starting call",
  active: "Connected",
  ending: "Ending call",
  ended: "Call ended",
  error: "Call failed",
};

const ACCENT: Record<AgentRole, string> = { trustline: "var(--color-gold)", sentinel: "var(--color-signal)", recovery: "var(--color-teal)" };

export function CallPanel({ call, role }: { call: VoiceCall; role: AgentRole | null }) {
  const persona = role ? AGENT_PERSONAS[role] : null;
  const [showRaw, setShowRaw] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const live = ["requesting", "connecting_upstream", "starting", "active", "ending"].includes(call.phase);
  const runtime = call.session?.mode === "mock" ? "Mock voice runtime" : "Alebex Voice Engine";

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [call.messages, call.drafts]);

  if (!persona) {
    return (
      <section className="surface flex min-h-[420px] flex-col justify-center p-6" aria-label="Voice call">
        <p className="t-h3">No call in progress</p>
        <p className="measure mt-2 text-mist">
          Trigger the suspicious-transaction scenario to receive a simulated Guardian call from Atlas, or call Maya at Guardian TrustLine yourself. Calls run in this browser tab through the
          Guardian gateway. They are not phone calls.
        </p>
      </section>
    );
  }

  const agentSpeaking = call.agentLevel > 0.02;
  const userSpeaking = call.micLevel > 0.02 && call.mic === "live";
  const text = (t: string) => (showRaw ? t : redact(t));

  return (
    <section className="surface flex min-h-[420px] flex-col" aria-label={`Voice call with ${persona.name}`} data-testid="call-panel" data-phase={call.phase}>
      <header className="flex flex-wrap items-center gap-3 border-b border-rule p-4">
        <span className="grid h-11 w-11 place-items-center rounded-full text-lg font-black text-navy" style={{ background: ACCENT[persona.role] }} aria-hidden="true">
          {persona.name[0]}
        </span>
        <div className="min-w-0">
          <p className="font-bold leading-tight">
            {persona.name}, {persona.title}
          </p>
          <p className="t-small text-mist">
            {runtime}
            {call.session?.toolsEnabled === false ? ", tools disabled (voice only)" : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2" role="status" aria-live="polite" data-testid="call-status">
          {call.phase === "active" ? <span className="live-dot" aria-hidden="true" /> : null}
          <span className="text-sm font-semibold">{PHASE_LABEL[call.phase]}</span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule/60 px-4 py-2.5 text-sm">
        <span className="flex items-center gap-2">
          <ActivityBars level={call.agentLevel} colour={ACCENT[persona.role]} label={agentSpeaking ? `${persona.name} is speaking` : `${persona.name} is quiet`} />
          <span className={agentSpeaking ? "font-semibold" : "text-mist"}>{agentSpeaking ? `${persona.name} speaking` : persona.name}</span>
        </span>
        <span className="flex items-center gap-2">
          <ActivityBars level={call.micLevel} colour="var(--color-paper)" label={userSpeaking ? "You are speaking" : "Your microphone is quiet"} />
          <span className={userSpeaking ? "font-semibold" : "text-mist"} data-testid="mic-state">
            {call.mic === "live" ? (userSpeaking ? "You're speaking" : "Mic on") : call.mic === "muted" ? "Mic muted" : call.mic === "starting" ? "Starting mic" : call.mic === "unavailable" ? "No mic" : "Mic off"}
          </span>
        </span>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-mist">
          <input type="checkbox" className="accent-[var(--color-signal)]" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
          Show unredacted
        </label>
      </div>

      {call.micNote ? <p className="t-small border-b border-rule/60 px-4 py-2 text-gold">{call.micNote}</p> : null}

      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto p-4" style={{ maxHeight: 360 }} data-testid="transcript" aria-live="polite" aria-relevant="additions">
        {call.messages.length === 0 && call.drafts.length === 0 ? <p className="t-small text-mist">{live ? "Waiting for the agent to speak…" : "The conversation will appear here."}</p> : null}
        {call.messages.map((m) => (
          <Bubble key={m.id} role={m.role} name={persona.name} text={text(m.text)} testId="message" />
        ))}
        {call.drafts.map((d) => (
          <Bubble key={d.id} role={d.role} name={persona.name} text={text(d.text)} testId="draft" live />
        ))}
      </div>

      {call.hints.length > 0 && call.phase === "active" ? (
        <div className="border-t border-rule/60 px-4 py-3" data-testid="hints">
          <p className="t-small mb-2 text-mist">Mock runtime has no speech recognition. Choose what you say:</p>
          <div className="flex flex-wrap gap-2">
            {call.hints.map((h) => (
              <button key={h} type="button" className="btn btn-ghost text-left !whitespace-normal !py-2 text-sm" onClick={() => call.sendMockUtterance(h)}>
                “{h}”
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {call.error ? (
        <div role="alert" className="mx-4 mb-3 rounded-xl border border-coral/60 bg-coral/10 p-3" data-testid="call-error">
          <p className="text-sm font-semibold text-coral">{call.error.message}</p>
          <button type="button" className="t-small mt-1 underline" onClick={call.dismissError}>
            Dismiss
          </button>
        </div>
      ) : null}

      <footer className="flex flex-wrap items-center gap-3 border-t border-rule p-4">
        <button type="button" className="btn btn-ghost" onClick={call.toggleMute} disabled={!live || call.mic === "unavailable"} aria-pressed={call.muted}>
          {call.muted ? "Unmute" : "Mute"}
        </button>
        <button type="button" className="btn btn-danger" onClick={call.end} disabled={!live || call.phase === "ending"} data-testid="end-call">
          End call
        </button>
        <p className="t-small ml-auto max-w-xs text-mist">Sandbox call. Guardian never asks for passwords, PINs or one-time codes. Audio is not recorded.</p>
      </footer>
    </section>
  );
}

function Bubble({ role, name, text, live = false, testId }: { role: "user" | "agent"; name: string; text: string; live?: boolean; testId: string }) {
  const mine = role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`} data-testid={testId} data-role={role}>
      <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 ${mine ? "bg-panel-2" : "border border-rule bg-navy/60"} ${live ? "opacity-80" : ""}`}>
        <p className="t-small font-semibold text-mist">
          {mine ? "You" : name}
          {live ? <span className="ml-2 text-signal">live</span> : null}
        </p>
        <p className="text-[0.95rem] leading-snug">{text}</p>
      </div>
    </div>
  );
}
