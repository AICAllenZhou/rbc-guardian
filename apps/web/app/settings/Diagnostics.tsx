"use client";

import { useEffect, useState } from "react";
import type { ReadinessReport } from "@guardian/shared";
import { api, GATEWAY_URL } from "@/lib/gateway";

export function Diagnostics() {
  const [r, setR] = useState<ReadinessReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .readiness()
        .then((x) => {
          setR(x);
          setErr(null);
        })
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Gateway unreachable"));
    void load();
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, []);

  const rows: [string, string, boolean | null][] = r
    ? [
        ["Alebex mode", r.mode === "mock" ? "Mock" : r.mode === "live" ? "Live" : "Live, voice only", null],
        ["Voice token configured", yes(r.voiceTokenConfigured), r.voiceTokenConfigured],
        ["TrustLine agent configured", yes(r.agents.trustline), r.agents.trustline],
        ["Sentinel agent configured", yes(r.agents.sentinel), r.agents.sentinel],
        ["Recovery agent configured", yes(r.agents.recovery), r.agents.recovery],
        ["Public tool URL configured", yes(r.publicToolUrlConfigured), r.publicToolUrlConfigured],
        ["Tool signing secret configured", yes(r.toolSigningSecretConfigured), r.toolSigningSecretConfigured],
        ["Gateway connected", yes(r.gatewayConnected), r.gatewayConnected],
        ["Last protocol probe", r.lastProbe.status === "not_run" ? "Not run" : `${r.lastProbe.status === "pass" ? "Pass" : "Fail"}${r.lastProbe.at ? `, ${new Date(r.lastProbe.at).toLocaleString("en-CA")}` : ""}`, r.lastProbe.status === "not_run" ? null : r.lastProbe.status === "pass"],
      ]
    : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="t-h2">Developer diagnostics</h1>
      <p className="measure mt-2 text-mist">Readiness only. Secret values are never sent to the browser; this page shows whether each one is set.</p>
      {err ? (
        <div role="alert" className="mt-6 rounded-xl border border-coral/60 bg-coral/10 p-4">
          <p className="font-semibold text-coral">Gateway connected: no</p>
          <p className="t-small mt-1">{err} Expected at {GATEWAY_URL}.</p>
        </div>
      ) : null}
      {r ? (
        <>
          <dl className="surface mt-6 divide-y divide-rule" data-testid="readiness">
            {rows.map(([k, v, ok]) => (
              <div key={k} className="flex items-center justify-between gap-4 px-5 py-3">
                <dt className="text-sm">{k}</dt>
                <dd className="text-sm font-semibold" style={{ color: ok === null ? "var(--color-paper)" : ok ? "var(--color-safe)" : "var(--color-coral)" }}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          {r.lastProbe.summary ? <p className="t-small mt-3 text-mist">Probe: {r.lastProbe.summary}</p> : null}
          {r.warnings.length ? (
            <section className="mt-6">
              <h2 className="t-h3">Warnings</h2>
              <ul className="mt-2 space-y-2">
                {r.warnings.map((w) => (
                  <li key={w} className="rounded-lg border border-gold/50 bg-gold/10 p-3 text-sm text-gold">
                    {w}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="mt-6">
            <h2 className="t-h3">Unrecognised Alebex frames</h2>
            {r.unknownFrames.length === 0 ? (
              <p className="t-small mt-1 text-mist">None seen since the gateway started.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {r.unknownFrames.map((f, i) => (
                  <li key={i} className="surface-quiet p-3 text-sm">
                    <p className="font-semibold">
                      {f.type}: {f.reason}
                    </p>
                    <pre className="t-small mt-1 overflow-x-auto text-mist">{JSON.stringify(f.shape)}</pre>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function yes(b: boolean): string {
  return b ? "Yes" : "No";
}
