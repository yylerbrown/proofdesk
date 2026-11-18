import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, parseArgs } from "../../ops/prove/cli.js";
import {
  fixAndTest,
  IMPL,
  makeFixture,
  makePatch,
  REGRESSION_TEST,
  removeFixture,
  TEST,
  type Fixture,
} from "./fixture.js";

let fx: Fixture;
let outRoot: string;
beforeAll(() => {
  fx = makeFixture();
  outRoot = mkdtempSync(path.join(os.tmpdir(), "prove-cli-out-"));
});
afterAll(() => {
  removeFixture(fx);
  rmSync(outRoot, { recursive: true, force: true });
});

// Runs main() and collects what it prints.
async function runCli(patchFile: string, out: string) {
  const lines: string[] = [];
  const args = ["--repo", fx.repo, "--base", fx.base, "--patch", patchFile];
  args.push("--impl", IMPL, "--test", TEST, "--out", out);
  const code = await main(args, (line) => lines.push(line));
  return { code, lines };
}

describe("prove cli", { timeout: 120_000 }, () => {
  it("exits 0 and prints one line per check for a proved patch", async () => {
    const out = path.join(outRoot, "good");
    const { code, lines } = await runCli(
      makePatch(fx, (d) => fixAndTest(d)),
      out,
    );
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^scope: accepted \(accepted: \d+ bytes, 8 changed lines\)$/);
    expect(lines.slice(1, 4)).toEqual([
      "baseline: held (existing suite passes on the base)",
      "red: held (new test fails on the old code)",
      "green: held (new test and full suite pass with the fix)",
    ]);
    expect(existsSync(path.join(out, "evidence.md"))).toBe(true);
  });

  it("exits 1 when the scope check rejects the patch and runs no tests", async () => {
    const out = path.join(outRoot, "rejected");
    const patchFile = makePatch(fx, (d) =>
      fixAndTest(d, REGRESSION_TEST.replace("it(", "it.only(")),
    );
    const { code, lines } = await runCli(patchFile, out);
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^scope: rejected \(focused-or-skipped-test/);
    expect(existsSync(path.join(out, "evidence.json"))).toBe(true);
  });

  it("exits 1 when red does not hold", async () => {
    const out = path.join(outRoot, "not-red");
    const passingTest = REGRESSION_TEST.replace(
      "clamp(11, 0, 10)).toBe(10)",
      "clamp(5, 0, 10)).toBe(5)",
    );
    const { code, lines } = await runCli(
      makePatch(fx, (d) => fixAndTest(d, passingTest)),
      out,
    );
    expect(code).toBe(1);
    expect(lines).toContain("red: failed (test does not fail on the old code)");
  });

  it("reports missing options", () => {
    expect(parseArgs(["--base", "abc"])).toMatch(/^missing --patch/);
    expect(parseArgs(["--base"])).toMatch(/^usage/);
    expect(parseArgs(["--colour", "red"])).toMatch(/^unknown option --colour/);
  });
});
