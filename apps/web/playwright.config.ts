import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    ...devices["Desktop Chrome"],
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: "pnpm --filter @wekants/api start",
          url: "http://127.0.0.1:3001/api/health",
          reuseExistingServer: false,
          cwd: new URL("../..", import.meta.url).pathname,
          env: {
            ...process.env,
            PORT: "3001",
            DATABASE_URL:
              process.env.DATABASE_URL ??
              "postgres://wekants:wekants@127.0.0.1:5432/wekants_test",
          },
        },
        {
          command: "pnpm --filter @wekants/web dev --host 127.0.0.1 --port 5173",
          url: "http://127.0.0.1:5173",
          reuseExistingServer: false,
          cwd: new URL("../..", import.meta.url).pathname,
        },
      ],
});
