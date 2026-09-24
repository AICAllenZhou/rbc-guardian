"use client";

import Link from "next/link";
import { AGENT_PERSONAS, formatCad, redact } from "@guardian/shared";
import { api } from "@/lib/gateway";
import { useCase } from "@/lib/useCase";
import { ProtectiveActions, ReverseAuthSeal, RiskMeter, StatusPill, Timeline } from "@/components/CaseWidgets";

export function CommandCenter({ caseId }: { caseId: string }) {
  const { view, loading, error, notFound, streaming } = useCase(caseId);

  if (loading) return <Shell>{<p className="text-mist">Loading case {caseId}…</p>}</Shell>;
  if (error)
    return (
      <Shell>
        <div role="alert" className="rounded-xl border border-coral/60 bg-coral/10 p-4">
          <p className="font-semibold text-coral">Couldn&apos;t load the case.</p>
          <p className="t-small mt-1">{error}</p>
        </div>
      </Shell>
    );
  if (notFound || !view)
    return (
      <Shell>
        <h1 className="t-h2">No case {caseId} yet</h1>
        <p className="measure mt-2 text-mist">Cases appear once the fraud engine flags a purchase or a customer calls TrustLine. Start one from the control room.</p>
        <Link href="/demo" className="btn btn-primary mt-6">
          Open the control room
        </Link>
      </Shell>
    );

  const { case: c, transaction: t, assessment, events, tools, sessions, messages, customer } = view;
  const history = c.riskHistory;
  const lastAgent = [...sessions].reverse()[0];
  const agentName = lastAgent ? AGENT_PERSONAS[lastAgent.role].name : "the agent";

  return (
    <Shell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="t-small text-mist">Fraud Command Center, sandbox</p>
          <h1 className="t-h2 mt-1" data-testid="cc-case-id">
            {c.id}
          </h1>
          <p className="measure mt-2 text-mist">{c.summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <StatusPill status={c.status} />
          <span className="chip">{streaming ? "Live updates on" : "Reconnecting"}</span>
          <a className="btn btn-ghost !py-1.5 text-sm" href={api.summaryUrl(c.id)} data-testid="export-json">
            Export JSON summary
          </a>
          <button type="button" className="btn btn-ghost !py-1.5 text-sm" onClick={() => window.print()}>
            Print summary
          </button>
        </div>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-3">
        <section className="surface p-5 lg:col-span-2">
          <h2 className="t-h3">Customer and transaction</h2>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Field k="Customer" v={customer ? `${customer.name}, ${customer.homeCity} ${customer.homeRegion}` : "Unknown"} />
            <Field k="Card" v={`Ending ${customer?.cardLast4 ?? "----"}${c.cardLocked ? ", locked (mock)" : ""}`} />
            {t ? (
              <>
                <Field k="Amount" v={formatCad(t.amountCents)} strong />
                <Field k="Merchant" v={`${t.merchant}, ${t.city} ${t.region}`} />
                <Field k="Device" v={t.device} />
                <Field k="Transaction status" v={t.status.replace("_", " ")} />
              </>
            ) : (
              <Field k="Reported contact" v={c.channel.replace("_", " ")} />
            )}
            <Field k="Travel notice" v={customer?.travelNotice ? "On file" : "None"} />
            <Field k="Opened" v={new Date(c.createdAt).toLocaleString("en-CA")} />
          </dl>
        </section>
        <section className="surface p-5">
          <h2 className="t-h3">Risk</h2>
          <div className="mt-3">
            <RiskMeter score={c.riskScore} band={assessment.band} />
          </div>
          <RiskHistory points={history.map((h) => h.score)} />
          <ol className="t-small mt-2 space-y-1 text-mist" data-testid="risk-history">
            {history.map((h, i) => (
              <li key={i}>
                <span className="font-semibold text-paper">{h.score}</span> {h.reason}
              </li>
            ))}
          </ol>
        </section>

        <section className="surface p-5">
          <h2 className="t-h3">Signal breakdown</h2>
          <ul className="mt-3 space-y-2" data-testid="signals">
            {assessment.signals.map((s) => (
              <li key={s.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span>{s.label}</span>
                <span className="shrink-0 font-bold tabular-nums">{s.points > 0 ? `+${s.points}` : s.points}</span>
              </li>
            ))}
          </ul>
          <p className="t-small mt-3 text-mist">Deterministic rules, capped at 99. No model decides the score.</p>
        </section>
        <section className="space-y-5">
          <ReverseAuthSeal auth={c.reverseAuth} agentName={agentName} />
          <div className="surface p-5">
            <h2 className="t-h3">Protective actions</h2>
            <div className="mt-3">
              <ProtectiveActions c={c} />
            </div>
          </div>
        </section>
        <section className="surface p-5">
          <h2 className="t-h3">Voice sessions</h2>
          {sessions.length === 0 ? (
            <p className="t-small mt-2 text-mist">No calls on this case yet.</p>
          ) : (
            <ul className="mt-3 space-y-3" data-testid="sessions">
              {sessions.map((s) => (
                <li key={s.id} className="text-sm">
                  <p className="font-semibold">
                    {AGENT_PERSONAS[s.role].name}, {AGENT_PERSONAS[s.role].title}
                  </p>
                  <p className="t-small text-mist">
                    {s.mode === "mock" ? "Mock runtime" : "Alebex Voice Engine"}, {s.toolsEnabled ? "tools on" : "tools off"}. {s.state === "ended" ? `Ended: ${(s.endReason ?? "").replaceAll("-", " ")}` : s.state}.
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="surface p-5 lg:col-span-2">
          <h2 className="t-h3">Audit trail</h2>
          <div className="mt-4">
            <Timeline events={events} testId="cc-timeline" />
          </div>
        </section>
        <section className="surface p-5">
          <h2 className="t-h3">Tool calls</h2>
          {tools.length === 0 ? (
            <p className="t-small mt-2 text-mist">No tools have been called.</p>
          ) : (
            <ul className="mt-3 space-y-2.5" data-testid="tool-calls">
              {tools.map((x) => (
                <li key={x.id} className="text-sm">
                  <p className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold">{x.tool}</span>
                    <span className={x.status === "ok" ? "t-small text-safe" : x.status === "replayed" ? "t-small text-mist" : "t-small text-coral"}>
                      {x.status === "replayed" ? "duplicate ignored" : x.status}, {x.durationMs} ms
                    </span>
                  </p>
                  <p className="t-small text-mist">
                    {new Date(x.at).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", second: "2-digit" })}, {x.sessionId === "operator" ? "operator action" : agentFor(sessions, x.sessionId)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="surface p-5 lg:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="t-h3">Transcript</h2>
            <p className="t-small text-mist">Redacted before storage: codes, card numbers, emails and phone numbers never reach the database.</p>
          </div>
          {messages.length === 0 ? (
            <p className="t-small mt-2 text-mist">No conversation recorded yet.</p>
          ) : (
            <ol className="measure mt-3 space-y-2" data-testid="cc-transcript">
              {messages.map((m) => (
                <li key={m.id} className="text-sm">
                  <span className="font-semibold">{m.role === "agent" ? agentFor(sessions, m.sessionId) : "Customer"}: </span>
                  {redact(m.text)}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Shell>
  );
}

function agentFor(sessions: { id: string; role: keyof typeof AGENT_PERSONAS }[], sid: string): string {
  const s = sessions.find((x) => x.id === sid);
  return s ? AGENT_PERSONAS[s.role].name : "Agent";
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">{children}</div>;
}

function Field({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) {
  return (
    <div>
      <dt className="t-small text-mist">{k}</dt>
      <dd className={strong ? "font-bold" : ""}>{v}</dd>
    </div>
  );
}

/** Step chart of the risk score over the case's life. */
function RiskHistory({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 260;
  const h = 56;
  const step = w / (points.length - 1);
  const y = (v: number) => h - (v / 99) * (h - 6) - 3;
  let d = `M0 ${y(points[0]!)}`;
  points.slice(1).forEach((p, i) => {
    d += ` H${(i + 1) * step} V${y(p)}`;
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-4 h-14 w-full" role="img" aria-label={`Risk went ${points.join(", then ")}`}>
      <line x1="0" x2={w} y1={y(90)} y2={y(90)} stroke="var(--color-coral)" strokeOpacity="0.35" strokeDasharray="3 4" />
      <path d={d} fill="none" stroke="var(--color-coral)" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}
