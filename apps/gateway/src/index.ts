import { assertValid, ConfigError, loadConfig } from "./env";
import { buildGateway } from "./server";
import { createLogger } from "./logger";

const log = createLogger();

async function main(): Promise<void> {
  const cfg = loadConfig();
  try {
    assertValid(cfg);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n[guardian-gateway] ${err.message}\n\nTip: set ALEBEX_MODE=mock to run the demo offline.\n\n`);
      process.exit(1);
    }
    throw err;
  }
  const pace = Number(process.env.MOCK_PACE ?? "1");
  const gw = await buildGateway(cfg, { logger: log, mock: { pace: Number.isFinite(pace) && pace >= 0 ? pace : 1 } });
  await gw.app.listen({ port: cfg.port, host: cfg.host });
  log.info("gateway.listening", {
    url: `http://${cfg.host}:${cfg.port}`,
    mode: cfg.mode,
    tokenConfigured: !!cfg.alebexToken,
    credentialVariable: cfg.tokenSource,
    agents: Object.fromEntries(Object.entries(cfg.agents).map(([k, v]) => [k, !!v])),
    publicToolUrl: !!cfg.publicToolBaseUrl,
  });
  for (const w of cfg.warnings) log.warn("config.warning", { message: w });

  const shutdown = async (signal: string) => {
    log.info("gateway.shutdown", { signal });
    await gw.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("gateway.fatal", { error: String(err) });
  process.exit(1);
});
