"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AGENT_PERSONAS, formatCad, type AgentRole, type ReadinessReport } from "@guardian/shared";
import { api, GatewayError } from "@/lib/gateway";
import { useCase } from "@/lib/useCase";
import { useVoiceCall } from "@/lib/voice/useVoiceCall";
import { CallPanel } from "@/components/CallPanel";
import { IncomingCall } from "@/components/IncomingCall";
import { ProtectiveActions, ReverseAuthSeal, RiskMeter, StatusPill, Timeline } from "@/components/CaseWidgets";

const SEED_CASE = "GUARD-4821";

export function DemoRoom() {
  const call = useVoiceCall();
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [gatewayDown, setGatewayDown] = useState<string | null>(null);
  const [ringing, setRinging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [role, setRole] = useState<AgentRole | null>(null);
  const [focusCase, setFocusCase] = useState<string>(SEED_CASE);

  const caseId = call.session?.caseId ?? focusCase;
  const live = useCase(caseId);
  const seeded = useCase(SEED_CASE);
  const detected = !!seeded.view;
  const inCall = ["requesting", "connecting_upstream", "starting", "active", "ending"].includes(call.phase);

  useEffect(() => {
    api
      .readiness()
      .then((r) => {
        setReadiness(r);
        setGatewayDown(null);
      })
      .catch((e: unknown) => setGatewayDown(e instanceof Error ? e.message : "Gateway unreachable"));
  }, []);

  const guard = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setNotice(err instanceof GatewayError ? err.message : "Something went wrong. Check that the gateway is running.");
    } finally {
      setBusy(null);
    }
  }, []);

  const trigger = () =>
    guard("detect", async () => {
      await api.detect();
      setFocusCase(SEED_CASE);
      await seeded.refresh();
      setRinging(true);
    });

  const startCall = async (r: AgentRole, id?: string) => {
    setRole(r);
    setRinging(false);
    await call.start(r, id);
  };

  const reset = () =>
    guard("reset", async () => {
      if (inCall) call.end();
      await api.reset();
      setRole(null);
      setFocusCase(SEED_CASE);
      setRinging(false);
      await Promise.all([seeded.refresh(), live.refresh()]);
    });

  const c = live.view?.case ?? null;
  const agentName = role ? AGENT_PERSONAS[role].name : "the agent";
  const voiceOnly = readiness?.mode === "live-voice-only";

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="t-h2">Guardian control room</h1>
          <p className="mt-1 text-mist">Run the fraud scenario, take the call, and watch the case change as the agent works.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {readiness ? (
            <span className="chip" data-testid="runtime-mode" style={readiness.mode === "mock" ? { borderColor: "var(--color-gold)", color: "var(--color-gold)" } : { borderColor: "var(--color-safe)", color: "var(--color-safe)" }}>
              {readiness.mode === "mock" ? "Mock voice runtime" : readiness.mode === "live" ? "Live: Alebex Voice Engine" : "Live voice only, tools off"}
            </span>
          ) : null}
          <button type="button" className="btn btn-ghost !py-1.5 text-sm" onClick={reset} disabled={busy !== null}>
            Reset demo
          </button>
        </div>
      </div>

      {gatewayDown ? (
        <div role="alert" className="mt-4 rounded-xl border border-coral/60 bg-coral/10 p-4">
          <p className="font-semibold text-coral">The Guardian gateway isn&apos;t running.</p>
          <p className="t-small mt-1 text-paper/80">{gatewayDown}</p>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 rounded-xl border border-gold/50 bg-gold/10 p-3 text-sm text-gold" data-testid="notice">
          {notice}
        </p>
      ) : null}

      <div className="mt-6 grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
        {/* Scenario and controls */}
        <div className="space-y-5">
          <section className="surface p-5" aria-labelledby="scenario-title">
            <h2 id="scenario-title" className="t-h3">
              Scenario: a purchase Sarah didn&apos;t make
            </h2>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-mist">Customer</dt>
              <dd>Sarah Chen, Vancouver</dd>
              <dt className="text-mist">Purchase</dt>
              <dd className="font-semibold">{formatCad(284_000)}</dd>
              <dt className="text-mist">Merchant</dt>
              <dd>Apple Store, Miami FL</dd>
              <dt className="text-mist">Device</dt>
              <dd>Unknown device</dd>
              <dt className="text-mist">Travel notice</dt>
              <dd>None</dd>
            </dl>
            <button type="button" className="btn btn-primary mt-4 w-full" onClick={trigger} disabled={busy !== null || inCall || !!gatewayDown} data-testid="trigger-detection">
              {detected ? "Replay incoming call" : "Trigger fraud detection"}
            </button>
            <p className="t-small mt-2 text-mist">The mock fraud engine scores the purchase, then Atlas calls you in this browser.</p>
          </section>

          <section className="surface p-5" aria-labelledby="agents-title">
            <h2 id="agents-title" className="t-h3">
              Other agents
            </h2>
            <button type="button" className="btn btn-ghost mt-3 w-full" onClick={() => startCall("trustline")} disabled={inCall || !!gatewayDown} data-testid="call-trustline">
              Call Guardian TrustLine
            </button>
            <p className="t-small mt-2 text-mist">You call Maya to report a suspicious call or text. She opens a new case.</p>
            <button type="button" className="btn btn-ghost mt-4 w-full" onClick={() => startCall("recovery", c && c.status !== "intake" ? c.id : undefined)} disabled={inCall || !!gatewayDown || !c || c.status === "intake"} data-testid="call-recovery">
              Continue with Nora, Recovery
            </button>
            <p className="t-small mt-2 text-mist">A new call with a different agent and voice that picks up the current case.</p>
          </section>

          <details className="surface p-5" open={voiceOnly}>
            <summary className="cursor-pointer font-semibold">Operator controls</summary>
            <p className="t-small mt-2 text-mist">
              {voiceOnly ? "Custom Tools are off in voice-only mode, so apply case actions here while the agent talks." : "Apply case actions by hand. Each one is labelled as an operator action in the audit trail."}
            </p>
            <div className="mt-3 grid gap-2">
              {[
                ["Issue reverse-auth phrase", "issue_reverse_auth_phrase", {}],
                ["Customer confirmed phrase", "record_customer_response", { response_type: "confirmed_reverse_auth" }],
                ["Customer denies purchase", "record_customer_response", { response_type: "denies_transaction" }],
                ["Caller asked for a code", "record_customer_response", { response_type: "was_asked_for_code" }],
                ["Lock card (mock)", "temporary_card_lock", { customer_confirmed: true, reason: "Operator action with customer consent" }],
                ["Flag transaction", "flag_suspicious_transaction", { reason: "Operator action" }],
                ["Request human review", "request_human_review", { priority: "urgent", summary: "Operator requested review from the control room." }],
              ].map(([label, tool, args]) => (
                <button
                  key={label as string}
                  type="button"
                  className="btn btn-ghost !justify-start !py-1.5 text-sm"
                  disabled={!c || busy !== null}
                  onClick={() => c && guard(String(label), async () => void (await api.operator(c.id, tool as string, args as Record<string, unknown>)))}
                >
                  {label as string}
                </button>
              ))}
            </div>
          </details>
        </div>

        {/* Call: on small screens it jumps to the top while a call is live, so you never scroll to find it. */}
        <div className={inCall || ringing ? "order-first lg:order-none" : ""}>
          <CallPanel call={call} role={call.session?.role ?? (call.phase === "requesting" ? role : call.error?.code === "busy" ? null : role)} />
          {/* On phones the case column is far below; keep the phrase next to the call while it matters. */}
          {inCall && c?.reverseAuth ? (
            <div className="mt-4 lg:hidden" data-testid="reverse-auth-mobile">
              <ReverseAuthSeal auth={c.reverseAuth} agentName={agentName} />
            </div>
          ) : null}
          {call.phase === "ended" && c ? (
            <div className="surface-quiet mt-4 flex flex-wrap items-center justify-between gap-3 p-4" data-testid="call-summary">
              <div>
                <p className="font-semibold">Call ended{call.lastEndReason ? ` (${call.lastEndReason.replaceAll("-", " ")})` : ""}.</p>
                <p className="t-small text-mist">
                  Case {c.id} is {c.status.replace("_", " ")} at risk {c.riskScore}. The full audit trail is in the Command Center.
                </p>
              </div>
              <Link href={`/cases/${c.id}`} className="btn btn-blue" data-testid="open-command-center">
                Open Command Center
              </Link>
            </div>
          ) : null}
        </div>

        {/* Case state */}
        <aside className="space-y-5" aria-label="Live case">
          {c && live.view ? (
            <>
              <section className="surface p-5" data-testid="case-card">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/cases/${c.id}`} className="font-bold underline-offset-4 hover:underline" data-testid="case-id">
                    {c.id}
                  </Link>
                  <StatusPill status={c.status} />
                </div>
                <p className="t-small mt-1 text-mist">{c.summary}</p>
                <div className="mt-4">
                  <RiskMeter score={c.riskScore} band={live.view.assessment.band} />
                </div>
              </section>
              <ReverseAuthSeal auth={c.reverseAuth} agentName={agentName} />
              <section className="surface p-5">
                <h2 className="t-h3">Protective actions</h2>
                <div className="mt-3">
                  <ProtectiveActions c={c} />
                </div>
              </section>
              <section className="surface p-5">
                <div className="flex items-center justify-between">
                  <h2 className="t-h3">Tool timeline, newest first</h2>
                  <span className="t-small text-mist">{live.streaming ? "Live" : "Reconnecting"}</span>
                </div>
                <div className="mt-4 max-h-80 overflow-y-auto pr-1">
                  <Timeline events={live.view.events} limit={14} newestFirst />
                </div>
              </section>
            </>
          ) : (
            <section className="surface p-5" data-testid="case-empty">
              <h2 className="t-h3">No open case</h2>
              <p className="t-small mt-1 text-mist">Trigger fraud detection or call TrustLine. The case, risk score and every agent action will appear here as they happen.</p>
            </section>
          )}
        </aside>
      </div>

      {ringing ? <IncomingCall caseId={SEED_CASE} onAnswer={() => void startCall("sentinel", SEED_CASE)} onDecline={() => setRinging(false)} /> : null}
    </div>
  );
}
