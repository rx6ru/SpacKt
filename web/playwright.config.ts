import { defineConfig } from "@playwright/test";

const backendURL = process.env.BACKEND_URL ?? "http://127.0.0.1:8080";
const frontendURL = process.env.WEB_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // Tests share one backend and one IP admission budget.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL: frontendURL, trace: "retain-on-failure" },
  webServer: process.env.WEB_URL
    ? undefined
    : [
        {
          command:
            "GOCACHE=/tmp/spackt-go-cache go -C ../backend run ./cmd/server -addr 127.0.0.1:8080",
          url: `${backendURL}/readyz`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command:
            "NEXT_PUBLIC_API_URL=http://127.0.0.1:8080 npm run dev -- --hostname 127.0.0.1",
          url: frontendURL,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      ],
});
