import { rmSync } from "node:fs";

// Removes the temporary database folder made by playwright.config.ts. Playwright stops the
// app itself after this runs.
export default function teardown(): void {
  const dir = process.env.BROWSER_TEST_DB_DIR;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
}
