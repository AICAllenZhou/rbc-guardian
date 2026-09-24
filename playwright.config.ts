import { defineConfig, devices } from "@playwright/test";

const WEB = 3100;
const GW = 3101;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB}`,
    trace: "retain-on-failure",
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @guardian/gateway exec tsx src/index.ts",
      url: `http://127.0.0.1:${GW}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ALEBEX_MODE: "mock", MOCK_PACE: "0.25", GATEWAY_PORT: String(GW), GATEWAY_ORIGIN: `http://127.0.0.1:${GW}`, APP_ORIGIN: `http://localhost:${WEB}`, DATABASE_URL: "file:./data/e2e.db", TOOL_SIGNING_SECRET: "e2e-signing-secret-not-for-production-use-000" },
    },
    {
      command: `pnpm --filter @guardian/web exec next dev --port ${WEB}`,
      url: `http://localhost:${WEB}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { NEXT_PUBLIC_GATEWAY_URL: `http://127.0.0.1:${GW}` },
    },
  ],
});
