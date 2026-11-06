import { defineConfig, devices } from "@playwright/test";

// Runs against the in-memory database (E2E_FAKE_DB), so no Supabase project is needed.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL: "http://localhost:3100", ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
  webServer: {
    command: "pnpm next dev -p 3100",
    url: "http://localhost:3100/login",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      E2E_FAKE_DB: "1", NEXT_PUBLIC_E2E: "1", NEXT_DIST_DIR: ".next-e2e",
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:9", NEXT_PUBLIC_SUPABASE_ANON_KEY: "unused", ALLOWED_EMAIL: "e2e@example.com",
    },
  },
});
