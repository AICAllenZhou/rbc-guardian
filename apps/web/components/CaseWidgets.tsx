import type { CaseEvent, GuardianCase, RiskAssessment } from "@guardian/shared";

const BAND_COLOUR: Record<RiskAssessment["band"], string> = {
  low: "var(--color-safe)",
  elevated: "var(--color-gold)",
  high: "#ff9f5a",
  critical: "var(--color-coral)",
};

const BAND_LABEL: Record<RiskAssessment["band"], string> = {
  low: "Low risk",
  elevated: "Elevated",
  high: "High risk",
  critical: "Critical",
};

export function RiskMeter({ score, band, compact = false }: { score: number; band: RiskAssessment["band"]; compact?: boolean }) {
  const colour = BAND_COLOUR[band];
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <p className={compact ? "text-3xl font-black tracking-tight" : "text-5xl font-black tracking-tight"} style={{ color: colour }}>
          <span data-testid="risk-score" className="nums">{score}</span>
          <span className="ml-1 text-base font-semibold text-mist">/ 99</span>
        </p>
        <span className="chip" style={{ borderColor: colour, color: colour }}>
          {BAND_LABEL[band]}
        </span>
      </div>
      <div
        className="meter-track mt-3 h-2.5 overflow-hidden rounded-full"
        role="meter"
        aria-label="Fraud risk score"
        aria-valuemin={0}
        aria-valuemax={99}
        aria-valuenow={score}
        aria-valuetext={`${score} out of 99, ${BAND_LABEL[band]}`}
      >
        <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${(score / 99) * 100}%`, background: colour }} />
      </div>
    </div>
  );
}

export function ReverseAuthSeal({ auth, agentName, large = false }: { auth: GuardianCase["reverseAuth"]; agentName: string; large?: boolean }) {
  if (!auth) {
    return (
      <div className="surface-quiet p-4" data-testid="reverse-auth-empty">
        <p className="t-h3">Reverse authentication</p>
        <p className="t-small mt-1 text-mist">When the agent starts, it proves it is the bank by issuing a phrase that appears here. You compare it with what you hear.</p>
      </div>
    );
  }
  return (
    <div className={`seal seal-in ${large ? "p-6" : "p-5"}`} data-testid="reverse-auth">
      <p className="t-small font-semibold text-gold">Your Guardian app shows</p>
      <p className={`seal-phrase mt-1 ${large ? "text-4xl" : "text-3xl"}`} data-testid="reverse-auth-phrase">
        {auth.phrase}
      </p>
      <p className="t-small mt-3 text-paper/85">
        {auth.verified ? (
          <span className="font-semibold text-safe" data-testid="reverse-auth-verified">
            Matched. You confirmed {agentName} read the same phrase.
          </span>
        ) : (
          <>If {agentName} reads a different phrase, hang up and call the number on the back of your card.</>
        )}
      </p>
    </div>
  );
}

const EVENT_TONE: Partial<Record<CaseEvent["type"], string>> = {
  detection: "var(--color-coral)",
  risk_changed: "var(--color-coral)",
  card_locked: "var(--color-safe)",
  transaction_flagged: "var(--color-safe)",
  human_review_requested: "var(--color-safe)",
  reverse_auth_issued: "var(--color-gold)",
  reverse_auth_verified: "var(--color-gold)",
  tool_called: "var(--color-signal)",
  tool_replayed: "var(--color-mist)",
  tool_failed: "var(--color-coral)",
  session_started: "var(--color-teal)",
  session_ended: "var(--color-teal)",
};

export function Timeline({ events, limit, newestFirst = false, testId = "timeline" }: { events: CaseEvent[]; limit?: number; newestFirst?: boolean; testId?: string }) {
  const recent = limit ? events.slice(-limit) : events;
  const list = newestFirst ? [...recent].reverse() : recent;
  if (list.length === 0) return <p className="t-small text-mist">Nothing has happened on this case yet.</p>;
  return (
    <ol className="relative space-y-3 border-l border-rule pl-5" data-testid={testId} aria-live="polite">
      {list.map((e) => (
        <li key={e.id} className="relative" data-event-type={e.type}>
          <span className="absolute -left-[1.62rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-navy" style={{ background: EVENT_TONE[e.type] ?? "var(--color-mist)" }} aria-hidden="true" />
          <div className="flex flex-wrap items-baseline gap-x-2">
            <p className="text-sm font-semibold">{e.title}</p>
            <time className="t-small text-mist" dateTime={e.at}>
              {new Date(e.at).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", second: "2-digit" })}
            </time>
          </div>
          {e.detail ? <p className="t-small text-mist">{e.detail}</p> : null}
          <p className="t-small text-mist/80">{e.actor}</p>
        </li>
      ))}
    </ol>
  );
}

export function ProtectiveActions({ c }: { c: GuardianCase }) {
  const rows = [
    { label: "Temporary card lock", done: c.cardLocked, testId: "action-lock", detail: c.cardLocked ? "Card ending 4417 locked (mock)" : "Not applied" },
    { label: "Transaction flagged", done: c.transactionFlagged, testId: "action-flag", detail: c.transactionFlagged ? "Held for investigation (mock)" : c.transactionId ? "Not flagged" : "No transaction on this case" },
    { label: "Human review", done: !!c.humanReview, testId: "action-review", detail: c.humanReview ? `Ticket ${c.humanReview.ticketId}, ${c.humanReview.priority} priority (mock queue)` : "Not requested" },
  ];
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="flex items-start gap-3" data-testid={r.testId} data-done={r.done}>
          <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] font-black ${r.done ? "border-safe bg-safe text-navy" : "border-rule text-transparent"}`} aria-hidden="true">
            ✓
          </span>
          <div>
            <p className="text-sm font-semibold">
              {r.label}
              <span className="sr-only">{r.done ? " — done" : " — not done"}</span>
            </p>
            <p className="t-small text-mist">{r.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function StatusPill({ status }: { status: GuardianCase["status"] }) {
  const map: Record<GuardianCase["status"], [string, string]> = {
    intake: ["Intake", "var(--color-mist)"],
    open: ["Open", "var(--color-coral)"],
    protected: ["Protected", "var(--color-safe)"],
    review_requested: ["Human review requested", "var(--color-safe)"],
    resolved: ["Resolved", "var(--color-safe)"],
  };
  const [label, colour] = map[status];
  return (
    <span className="chip" style={{ borderColor: colour, color: colour }} data-testid="case-status">
      {label}
    </span>
  );
}

/** Small bar visual for audio activity. Heights follow the live level; static when reduced motion is on. */
export function ActivityBars({ level, colour, label }: { level: number; colour: string; label: string }) {
  const bars = [0.55, 0.85, 1, 0.7, 0.45];
  const l = Math.min(1, level * 4);
  return (
    <span className="inline-flex h-5 items-center gap-[3px]" role="img" aria-label={label}>
      {bars.map((b, i) => (
        <span key={i} className="w-[3px] rounded-full transition-[height] duration-100" style={{ height: `${Math.max(3, 20 * b * (0.15 + l))}px`, background: colour, opacity: l > 0.05 ? 1 : 0.35 }} />
      ))}
    </span>
  );
}
