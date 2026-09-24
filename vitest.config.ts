import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/*/test/**/*.test.ts", "apps/gateway/test/unit/**/*.test.ts", "apps/web/test/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["apps/gateway/test/integration/**/*.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
