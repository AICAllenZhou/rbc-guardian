"use client";

import { useEffect, useRef } from "react";
import { AGENT_PERSONAS } from "@guardian/shared";

/** A clearly labelled SIMULATED incoming call. It is a browser prompt, not telephony. */
export function IncomingCall({ onAnswer, onDecline, caseId }: { onAnswer: () => void; onDecline: () => void; caseId: string }) {
  const answerRef = useRef<HTMLButtonElement>(null);
  const atlas = AGENT_PERSONAS.sentinel;

  useEffect(() => {
    answerRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDecline();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDecline]);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-navy/80 p-4 backdrop-blur-sm">
      <div role="alertdialog" aria-modal="true" aria-labelledby="incoming-title" aria-describedby="incoming-desc" className="surface w-full max-w-sm p-6 text-center shadow-2xl" data-testid="incoming-call">
        <p className="chip mx-auto border-gold/60 text-gold">Simulated browser call</p>
        <div className="ringing mx-auto mt-5 grid h-20 w-20 place-items-center rounded-full bg-signal text-3xl font-black text-navy" aria-hidden="true">
          A
        </div>
        <h2 id="incoming-title" className="t-h2 mt-4">
          {atlas.name} from Guardian
        </h2>
        <p className="font-semibold text-mist">{atlas.title}</p>
        <p id="incoming-desc" className="t-small measure mx-auto mt-3 text-mist">
          About case {caseId}: a purchase your bank&apos;s fraud engine flagged. Atlas will prove it&apos;s the bank before asking you anything. This is a concept demo in your browser, not a phone
          call.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button type="button" className="btn btn-ghost" onClick={onDecline}>
            Decline
          </button>
          <button ref={answerRef} type="button" className="btn btn-answer" onClick={onAnswer} data-testid="answer-call">
            Answer
          </button>
        </div>
      </div>
    </div>
  );
}
