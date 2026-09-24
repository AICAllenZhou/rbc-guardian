import Link from "next/link";
import { AGENT_PERSONAS, DISCLAIMER, ROLE_TOOLS, type AgentRole } from "@guardian/shared";

const STEPS = [
  { title: "Something looks wrong", body: "The mock fraud engine flags a purchase, or you get a call or text that claims to be your bank." },
  { title: "The bank proves it first", body: "Before asking you anything, the Guardian agent issues a one-time phrase to your app and reads it aloud. If it doesn't match, you hang up." },
  { title: "You decide, out loud", body: "Tell the agent whether you recognise the activity. It records each answer, and the risk score updates in front of you." },
  { title: "Protection, with consent", body: "Only after you say yes does the agent lock the card, flag the purchase and queue a human review. Every step lands in an audit trail." },
];

const ACCENT: Record<AgentRole, string> = { trustline: "var(--color-gold)", sentinel: "var(--color-signal)", recovery: "var(--color-teal)" };
const DIRECTION: Record<AgentRole, string> = { trustline: "You call in", sentinel: "Guardian calls you", recovery: "Picks up your case" };

export default function Landing() {
  return (
    <>
      {/* Hero: the phrase match is the product, so it is the first thing you see. */}
      <section className="mx-auto grid max-w-7xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:pt-20">
        <div>
          <h1 className="t-display">The bank proves itself first.</h1>
          <p className="t-lede measure mt-6">
            RBC Guardian is a browser voice concept for fraud defence. Specialised voice agents verify their own identity to you, help you judge a suspicious call or purchase, and take protective
            action only when you say so.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/demo" className="btn btn-primary text-base" data-testid="launch-demo">
              Launch the live demo
            </Link>
            <a href="#how" className="btn btn-ghost text-base">
              See how it works
            </a>
          </div>
          <p className="t-small mt-6 max-w-md text-mist">{DISCLAIMER}</p>
        </div>

        <figure className="relative" aria-label="Example: the agent reads a phrase and your app shows the same phrase">
          <div className="surface max-w-md p-5">
            <p className="t-small font-semibold text-signal">Atlas, Fraud Sentinel</p>
            <p className="mt-1 text-lg leading-snug">
              “I will never ask for your password, PIN or a one-time code. Your Guardian app is now showing a phrase. Mine reads <span className="font-extrabold text-gold">BLUE MAPLE</span>. Does that
              match?”
            </p>
          </div>
          <div className="seal ml-auto -mt-4 w-[78%] max-w-sm p-6 sm:-mt-6" aria-hidden="false">
            <p className="t-small font-semibold text-gold">Your Guardian app shows</p>
            <p className="seal-phrase mt-1 text-4xl sm:text-5xl">BLUE MAPLE</p>
            <p className="t-small mt-4 text-paper/85">Same words? Then it&apos;s really your bank. Different words, or no phrase at all? Hang up.</p>
          </div>
          <figcaption className="sr-only">A matching phrase on the call and in the app proves the caller is the bank.</figcaption>
        </figure>
      </section>

      <section className="border-y border-rule/70 bg-panel/40">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 md:grid-cols-[0.8fr_1.2fr]">
          <h2 className="t-h2">Scam calls work because customers are asked to trust first.</h2>
          <div className="measure space-y-4 text-mist">
            <p>
              A fraudster calls, spoofs the bank&apos;s number, sounds official and asks for “just the code we texted you”. The customer has no way to check who is on the line, so the burden of proof
              falls on the person being targeted.
            </p>
            <p className="text-paper">Guardian reverses it. The agent authenticates to you with a phrase only your real app can show, before discussing anything.</p>
          </div>
        </div>
      </section>

      <section id="how" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-16 sm:px-6">
        <h2 className="t-h2">How a Guardian call works</h2>
        <ol className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="border-t-2 border-rule pt-4">
              <p className="text-3xl font-black text-rule" aria-hidden="true">
                {i + 1}
              </p>
              <h3 className="t-h3 mt-2">{s.title}</h3>
              <p className="mt-2 text-mist">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-16 sm:px-6" aria-labelledby="arch-title">
        <h2 id="arch-title" className="t-h2">
          What runs where
        </h2>
        <p className="measure mt-3 text-mist">
          The Alebex Voice Engine runs the whole conversation: it listens, reasons and speaks. Guardian&apos;s own code holds the case, the rules and the tools, and keeps the Alebex key off your device.
        </p>
        <div className="mt-8 grid items-stretch gap-3 lg:grid-cols-[1fr_auto_1.2fr_auto_1fr]" data-testid="architecture">
          <ArchBox title="Your browser" lines={["Microphone at 16 kHz, 200 ms frames", "Agent audio at 24 kHz", "Live transcript and case view"]} />
          <Arrow label="WebSocket, one-time ticket" />
          <ArchBox
            title="Guardian gateway"
            highlight
            lines={["Holds the Alebex key server-side", "Chooses the agent for each role", "Mints short-lived tool credentials", "Mock bank core, risk rules, audit trail"]}
          />
          <Arrow label="Alebex WebSocket, start_call" />
          <ArchBox title="Alebex Voice Engine" lines={["Agent prompt, voice and model", "Speech in, reasoning, speech out", "Calls Guardian tools over HTTPS"]} />
        </div>
      </section>

      <section className="border-t border-rule/70 bg-panel/40">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <h2 className="t-h2">Three agents, three voices, three sets of permissions</h2>
          <p className="measure mt-3 text-mist">Each agent gets only the tools its job needs. Maya can open a case but cannot lock a card. Nora can request a review but cannot issue a phrase.</p>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {(Object.keys(AGENT_PERSONAS) as AgentRole[]).map((r) => {
              const p = AGENT_PERSONAS[r];
              return (
                <article key={r} className="surface flex flex-col p-6" style={{ borderTop: `3px solid ${ACCENT[r]}` }}>
                  <p className="t-small font-semibold" style={{ color: ACCENT[r] }}>
                    {DIRECTION[r]}
                  </p>
                  <h3 className="t-h2 mt-1">{p.name}</h3>
                  <p className="font-semibold text-mist">{p.title}</p>
                  <p className="mt-3 flex-1">{p.summary}</p>
                  <p className="t-small mt-4 text-mist">Voice: {p.voice.toLowerCase()}.</p>
                  <p className="t-small mt-1 text-mist">{ROLE_TOOLS[r].length} tools on each call.</p>
                </article>
              );
            })}
          </div>
          <div className="mt-10">
            <Link href="/demo" className="btn btn-primary text-base">
              Launch the live demo
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

function ArchBox({ title, lines, highlight = false }: { title: string; lines: string[]; highlight?: boolean }) {
  return (
    <div className={highlight ? "seal p-5" : "surface p-5"}>
      <p className={`t-h3 ${highlight ? "text-gold" : ""}`}>{title}</p>
      <ul className="t-small mt-3 space-y-1.5 text-paper/85">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex flex-row items-center justify-center gap-2 py-1 lg:flex-col lg:px-1" aria-hidden="true">
      <span className="block h-6 w-px bg-signal lg:h-px lg:w-10" />
      <span className="t-small max-w-[9rem] text-center text-signal">{label}</span>
      <span className="block h-6 w-px bg-signal lg:h-px lg:w-10" />
    </div>
  );
}
