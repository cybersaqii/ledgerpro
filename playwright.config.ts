import { defineConfig, devices } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * LedgerPro E2E — money-path coverage.
 * Runs against a local dev server with an isolated SQLite database.
 *
 * The dev server is started by the config's webServer with
 * E2E=1 so the app boots a throwaway database file instead of
 * touching the developer's dev.db.
 *
 * Two projects:
 *  - "api": full money-path coverage through the HTTP API using the
 *    `request` fixture. Needs NO browser binary — runs anywhere.
 *  - "chromium": UI smoke tests (landing, login, language toggle).
 *    Included only when a Playwright Chromium binary is installed
 *    (`npx playwright install chromium`).
 */
function hasChromium(): boolean {
  try {
    const dir = join(homedir(), ".cache", "ms-playwright");
    return readdirSync(dir).some((d) => d.startsWith("chromium-") && existsSync(join(dir, d)));
  } catch {
    return false;
  }
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "api",
      testMatch: /.*\.api\.spec\.ts/,
    },
    ...(hasChromium()
      ? [
          {
            name: "chromium",
            testMatch: /.*\.ui\.spec\.ts/,
            use: { ...devices["Desktop Chrome"] },
          },
        ]
      : []),
  ],
  webServer: {
    command: "E2E=1 PORT=3100 node scripts/e2e-server.mjs",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      E2E: "1",
      PORT: "3100",
    },
  },
});
