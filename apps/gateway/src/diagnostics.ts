import { describeShape } from "@guardian/alebex-protocol";
import type { AgentRole, ReadinessReport } from "@guardian/shared";
import type { GatewayConfig } from "./env";
import type { Store } from "./store";

/** Ring buffer of unrecognised upstream frames — shapes only, never values. */
export class Diagnostics {
  private unknown: ReadinessReport["unknownFrames"] = [];
  readonly counters = { sessions: 0, micFramesDropped: 0, upstreamErrors: 0 };
  readonly variants = new Map<string, number>();

  recordUnknown(type: string, reason: string, raw: unknown): void {
    this.unknown.unshift({ type, reason, shape: describeShape(raw), at: new Date().toISOString() });
    this.unknown = this.unknown.slice(0, 20);
  }

  recordVariant(kind: string, variant: string): void {
    const k = `${kind}:${variant}`;
    this.variants.set(k, (this.variants.get(k) ?? 0) + 1);
  }

  readiness(cfg: GatewayConfig, store: Store): ReadinessReport {
    const probeRaw = store.getKv("last_probe");
    let lastProbe: ReadinessReport["lastProbe"] = { status: "not_run", at: null, summary: null };
    if (probeRaw) {
      try {
        lastProbe = JSON.parse(probeRaw) as ReadinessReport["lastProbe"];
      } catch {
        /* ignore corrupt entry */
      }
    }
    const agents = Object.fromEntries((["trustline", "sentinel", "recovery"] as AgentRole[]).map((r) => [r, cfg.mode === "mock" ? true : !!cfg.agents[r]])) as Record<AgentRole, boolean>;
    return {
      mode: cfg.mode,
      voiceTokenConfigured: !!cfg.alebexToken,
      agents,
      singleAgentFallback: cfg.singleAgentFallback,
      publicToolUrlConfigured: !!cfg.publicToolBaseUrl,
      toolSigningSecretConfigured: !cfg.signingSecretEphemeral,
      gatewayConnected: true,
      lastProbe,
      warnings: cfg.warnings,
      unknownFrames: this.unknown,
    };
  }
}
