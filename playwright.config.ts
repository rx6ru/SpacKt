import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", fullyParallel: false, retries: process.env.CI ? 1 : 0,
  use: { baseURL: process.env.WEB_URL ?? "http://127.0.0.1:3000", trace: "retain-on-failure" },
  webServer: process.env.WEB_URL ? undefined : {
    command: "pnpm --dir web dev --hostname 127.0.0.1", url: "http://127.0.0.1:3000", reuseExistingServer: !process.env.CI
  }
});
