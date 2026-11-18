import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// The browser test. It starts the app itself on its own port, with the development entrance
// on and a database in a fresh temporary folder, and stops it when the run ends. Run it with
// `npm run test:browser`. The fast unit suite (`npm test`) does not include it.

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "../..");

// Not 3000, so it never meets a copy of the app someone is running by hand.
const port = Number(process.env.BROWSER_TEST_PORT ?? 3999);

// The config file is read again by each test worker. The folder is made once, by the first
// read, and handed to the later reads through the environment.
process.env.BROWSER_TEST_DB_DIR ??= mkdtempSync(path.join(tmpdir(), "support-desk-browser-"));
const databasePath = path.join(process.env.BROWSER_TEST_DB_DIR, "app.db");

export default defineConfig({
  testDir: here,
  testMatch: "*.spec.ts",
  outputDir: path.join(rootDir, "test-results/browser"),
  globalTeardown: path.join(here, "teardown.ts"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx tsx src/server/index.ts",
    cwd: rootDir,
    url: `http://127.0.0.1:${port}/api/health`,
    // Never attach to a server that is already running: it would not have the empty
    // database or the development entrance this test needs.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      NODE_ENV: "test",
      PORT: String(port),
      DATABASE_PATH: databasePath,
      DEV_SIGN_IN: "on",
      TICKET_PREFIX: "SUP",
      DEMO: "off",
      // Empty counts as not set, so GitHub sign-in stays off even if the shell has these.
      BETTER_AUTH_SECRET: "",
      BETTER_AUTH_URL: "",
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
    },
  },
});
