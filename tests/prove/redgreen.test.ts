import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRedGreen, type CheckStatus } from "../../ops/prove/redgreen.js";
import {
  BUGGY_CLAMP,
  EXISTING_TEST,
  fixAndTest,
  FIXED_CLAMP,
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
  outRoot = mkdtempSync(path.join(os.tmpdir(), "prove-out-"));
});
afterAll(() => {
  removeFixture(fx);
  rmSync(outRoot, { recursive: true, force: true });
});

interface Case {
  name: string;
  test: string; // content of the new test file
  impl: string; // content of the module after the patch
  baseline: CheckStatus;
  red: CheckStatus;
  green: CheckStatus;
  reason?: RegExp; // expected reason of the first check that is not "held"
  timeoutMs?: number;
}

const cases: Case[] = [
  {
    name: "a correct fix with a real regression test",
    test: REGRESSION_TEST,
    impl: FIXED_CLAMP,
    baseline: "held",
    red: "held",
    green: "held",
  },
  {
    name: "a new test that already passes on the base",
    test: EXISTING_TEST,
    impl: FIXED_CLAMP,
    baseline: "held",
    red: "failed",
    green: "held",
    reason: /test does not fail on the old code/,
  },
  {
    name: "a new test with a syntax error",
    test: REGRESSION_TEST.replace("toBe(10)", "toBe(10"),
    impl: FIXED_CLAMP,
    baseline: "held",
    red: "inconclusive",
    green: "failed",
    reason: /other-failure/,
  },
  {
    name: "a new test with a bad import",
    test: REGRESSION_TEST.replace("../src/clamp.js", "../src/missing.js"),
    impl: FIXED_CLAMP,
    baseline: "held",
    red: "inconclusive",
    green: "failed",
    reason: /other-failure/,
  },
  {
    name: "a new test that hangs",
    test: REGRESSION_TEST.replace("expect(", "while (Date.now() > 0) {}\n  expect("),
    impl: FIXED_CLAMP,
    baseline: "held",
    red: "inconclusive",
    green: "inconclusive",
    reason: /timeout/,
    timeoutMs: 5000,
  },
  {
    name: "a fix that does not make the test pass",
    test: REGRESSION_TEST,
    impl: BUGGY_CLAMP.replace("if (n > hi) return lo;", "if (n > hi) return hi - 1;"),
    baseline: "held",
    red: "held",
    green: "failed",
    reason: /new test does not pass with the fix/,
  },
  {
    name: "a fix that breaks an existing test",
    test: REGRESSION_TEST,
    impl: FIXED_CLAMP.replace("if (n < lo) return lo;", "if (n < lo) return hi;"),
    baseline: "held",
    red: "held",
    green: "failed",
    reason: /full suite does not pass with the fix/,
  },
];

describe("checkRedGreen", { timeout: 120_000 }, () => {
  it.each(cases)("$name", async (c) => {
    const patchFile = makePatch(fx, (d) => fixAndTest(d, c.test, c.impl));
    const result = await checkRedGreen({
      repo: fx.repo,
      base: fx.base,
      patchFile,
      implPath: IMPL,
      testPath: TEST,
      timeoutMs: c.timeoutMs ?? 60_000,
    });
    const statuses = [result.baseline.status, result.red.status, result.green.status];
    expect(statuses).toEqual([c.baseline, c.red, c.green]);
    expect(result.ok).toBe(statuses.every((s) => s === "held"));
    const firstMiss = [result.baseline, result.red, result.green].find((r) => r.status !== "held");
    if (c.reason) expect(firstMiss?.reason).toMatch(c.reason);
  });

  it("records the assertion message for red and writes the evidence report", async () => {
    const patchFile = makePatch(fx, (d) => fixAndTest(d));
    const outDir = path.join(outRoot, "good");
    const result = await checkRedGreen({
      repo: fx.repo,
      base: fx.base,
      patchFile,
      implPath: IMPL,
      testPath: TEST,
      outDir,
    });
    expect(result.ok).toBe(true);
    expect(result.red.failureMessage).toMatch(/^AssertionError: expected \+?0 to be 10/);

    const evidence = JSON.parse(readFileSync(path.join(outDir, "evidence.json"), "utf8"));
    const sha = createHash("sha256").update(readFileSync(patchFile)).digest("hex");
    expect(evidence.baseCommit).toBe(fx.base);
    expect(evidence.patchSha256).toBe(sha);
    expect(evidence.testPath).toBe(TEST);
    expect(evidence.red.status).toBe("held");
    expect(evidence.red.commands.join("\n")).toContain(`--include=${TEST}`);

    const markdown = readFileSync(path.join(outDir, "evidence.md"), "utf8");
    expect(markdown).toContain("| red | held | new test fails on the old code |");
    expect(markdown).toMatch(/AssertionError: expected \+?0 to be 10/);
  });

  it("refuses an evidence directory inside the repository", async () => {
    const patchFile = makePatch(fx, (d) => fixAndTest(d));
    await expect(
      checkRedGreen({
        repo: fx.repo,
        base: fx.base,
        patchFile,
        implPath: IMPL,
        testPath: TEST,
        outDir: path.join(fx.repo, "evidence"),
      }),
    ).rejects.toThrow(/outside the repository/);
  });
});
