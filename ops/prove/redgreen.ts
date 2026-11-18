// Red/green check: does the new test prove the fix?
//
// Three clean temporary workspaces, each a fresh checkout of the base commit:
//   baseline  base only: the existing suite passes.
//   red       base plus only the new test: that test fails with an assertion.
//   green     base plus the whole patch: the new test and the full suite pass.
// vitest's JSON reporter tells an assertion failure apart from a test file
// that could not load (syntax error, bad import), which is "inconclusive".

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScopeResult } from "./scope.js";
import { git, isInside, makeWorkspace, removeWorkspace, runCommand, tryGit } from "./run.js";
import type { Workspace } from "./run.js";

export const DEFAULT_TIMEOUT_MS = 120_000;

export interface RedGreenInput {
  repo: string;
  base: string;
  patchFile: string;
  implPath: string;
  testPath: string;
  outDir?: string; // where the evidence report goes; must be outside the repo
  timeoutMs?: number; // per test run
  scope?: ScopeResult; // copied into the evidence report when given
}

// held: the check proved what it should. failed: it proved the opposite.
// inconclusive: the run could not tell (load error, no tests, timeout, crash).
export type CheckStatus = "held" | "failed" | "inconclusive";

export interface CheckResult {
  status: CheckStatus;
  reason: string;
  failureMessage?: string; // for red: the assertion message that was seen
  commands: string[];
}

export interface RedGreenResult {
  ok: boolean;
  baseline: CheckResult;
  red: CheckResult;
  green: CheckResult;
}

// What one vitest run showed.
type Outcome = "passed" | "assertion-failure" | "other-failure" | "no-tests" | "timeout" | "crash";

interface VitestRun {
  command: string;
  outcome: Outcome;
  message: string;
  files: string[]; // test files vitest ran, relative to the workspace
}

// The parts of vitest's JSON report that are used here.
interface JsonReport {
  numTotalTests: number;
  testResults: {
    name: string;
    status: string;
    message: string;
    assertionResults: { status: string; failureMessages: string[] }[];
  }[];
}

export async function checkRedGreen(input: RedGreenInput): Promise<RedGreenResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const patchFile = path.resolve(input.patchFile);
  if (input.outDir !== undefined && isInside(input.repo, input.outDir)) {
    throw new Error("the evidence directory must be outside the repository");
  }

  const baseline = await inWorkspace(input, async (ws) => {
    const run = await runVitest(ws, undefined, timeoutMs);
    const commands = [run.command];
    if (run.outcome === "passed") return held("existing suite passes on the base", commands);
    if (run.outcome === "timeout" || run.outcome === "crash") {
      return inconclusive(run.outcome, run.message, commands);
    }
    return failed(`existing suite does not pass on the base (${run.outcome})`, commands, run);
  });

  const red = await inWorkspace(input, async (ws) => {
    const apply = ["apply", `--include=${input.testPath}`, patchFile];
    const applied = await tryGit(ws.dir, apply);
    const commands = [applied.command];
    if (applied.exitCode !== 0)
      return inconclusive("test file does not apply", applied.stderr, commands);
    const run = await runVitest(ws, input.testPath, timeoutMs);
    commands.push(run.command);
    if (run.outcome === "assertion-failure") {
      return { ...held("new test fails on the old code", commands), failureMessage: run.message };
    }
    if (run.outcome === "passed")
      return failed("test does not fail on the old code", commands, run);
    return inconclusive(run.outcome, run.message, commands);
  });

  const green = await inWorkspace(input, async (ws) => {
    const applied = await tryGit(ws.dir, ["apply", patchFile]);
    const commands = [applied.command];
    if (applied.exitCode !== 0)
      return inconclusive("patch does not apply", applied.stderr, commands);
    const single = await runVitest(ws, input.testPath, timeoutMs);
    commands.push(single.command);
    if (single.outcome === "timeout" || single.outcome === "crash") {
      return inconclusive(single.outcome, single.message, commands);
    }
    if (single.outcome !== "passed") {
      return failed(`new test does not pass with the fix (${single.outcome})`, commands, single);
    }
    const suite = await runVitest(ws, undefined, timeoutMs);
    commands.push(suite.command);
    if (suite.outcome === "timeout" || suite.outcome === "crash") {
      return inconclusive(suite.outcome, suite.message, commands);
    }
    if (suite.outcome !== "passed") {
      return failed(`full suite does not pass with the fix (${suite.outcome})`, commands, suite);
    }
    if (!suite.files.includes(input.testPath)) {
      return failed("full suite does not run the new test", commands, suite);
    }
    return held("new test and full suite pass with the fix", commands);
  });

  const result = {
    ok: baseline.status === "held" && red.status === "held" && green.status === "held",
    baseline,
    red,
    green,
  };
  if (input.outDir !== undefined) await writeEvidence(input, result);
  return result;
}

function held(reason: string, commands: string[]): CheckResult {
  return { status: "held", reason, commands };
}

function failed(reason: string, commands: string[], run: VitestRun): CheckResult {
  return { status: "failed", reason, failureMessage: run.message || undefined, commands };
}

function inconclusive(reason: string, message: string, commands: string[]): CheckResult {
  return { status: "inconclusive", reason, failureMessage: message.trim() || undefined, commands };
}

// Makes a fresh workspace, runs one check in it, and always deletes it.
// Workspace paths in the recorded commands are shortened to <workspace>.
async function inWorkspace(
  input: RedGreenInput,
  check: (ws: Workspace) => Promise<CheckResult>,
): Promise<CheckResult> {
  const ws = await makeWorkspace(input.repo, input.base);
  try {
    const result = await check(ws);
    result.commands = result.commands.map((c) => c.split(ws.root).join("<workspace>"));
    return result;
  } finally {
    await removeWorkspace(ws);
  }
}

let reportCounter = 0;

// Runs vitest once in a workspace, either the whole suite or one file, and
// reads its JSON report. The report file sits next to the checkout, not in it.
async function runVitest(
  ws: Workspace,
  onlyFile: string | undefined,
  timeoutMs: number,
): Promise<VitestRun> {
  reportCounter += 1;
  const reportFile = path.join(ws.root, `vitest-report-${reportCounter}.json`);
  await rm(reportFile, { force: true });
  const vitest = path.join(ws.dir, "node_modules", "vitest", "vitest.mjs");
  const args = [vitest, "run", "--reporter=json", `--outputFile=${reportFile}`];
  if (onlyFile !== undefined) args.push(onlyFile);

  const proc = await runCommand(process.execPath, args, ws.dir, timeoutMs);
  const base = { command: proc.command, files: [] as string[] };
  if (proc.timedOut) {
    return { ...base, outcome: "timeout", message: `no result after ${timeoutMs} ms` };
  }
  if (!existsSync(reportFile)) {
    return { ...base, outcome: "crash", message: lastLines(proc.stderr || proc.stdout) };
  }

  let report: JsonReport;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8")) as JsonReport;
  } catch {
    return { ...base, outcome: "crash", message: "vitest wrote a report that is not JSON" };
  }
  const files = report.testResults.map((r) =>
    path.relative(ws.dir, r.name).split(path.sep).join("/"),
  );
  const run = { ...base, files };

  // A test file that failed as a whole (it did not load) carries a message.
  const broken = report.testResults.find((r) => r.status === "failed" && r.message !== "");
  if (broken) return { ...run, outcome: "other-failure", message: firstLine(broken.message) };
  if (report.numTotalTests === 0) return { ...run, outcome: "no-tests", message: "no tests ran" };
  if (onlyFile !== undefined && files.some((f) => f !== onlyFile)) {
    return { ...run, outcome: "other-failure", message: `ran other files: ${files.join(", ")}` };
  }

  const failures = report.testResults
    .flatMap((r) => r.assertionResults)
    .filter((a) => a.status === "failed")
    .map((a) => a.failureMessages[0] ?? "");
  if (failures.length === 0) {
    if (proc.exitCode === 0) return { ...run, outcome: "passed", message: "" };
    return { ...run, outcome: "other-failure", message: lastLines(proc.stderr) };
  }
  const notAssertion = failures.find((m) => !m.startsWith("AssertionError"));
  if (notAssertion !== undefined) {
    return { ...run, outcome: "other-failure", message: firstLine(notAssertion) };
  }
  return { ...run, outcome: "assertion-failure", message: firstLine(failures[0] ?? "") };
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").slice(0, 500);
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-5).join("\n").slice(0, 1000);
}

// Writes evidence.json and evidence.md into the output directory.
async function writeEvidence(input: RedGreenInput, result: RedGreenResult): Promise<void> {
  const outDir = input.outDir as string;
  const patch = await readFile(input.patchFile);
  const evidence = {
    ok: result.ok,
    baseCommit: (await git(input.repo, ["rev-parse", "--verify", `${input.base}^{commit}`])).trim(),
    patchFile: path.resolve(input.patchFile),
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    implPath: input.implPath,
    testPath: input.testPath,
    scope: input.scope,
    baseline: result.baseline,
    red: result.red,
    green: result.green,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");

  const row = (name: string, c: CheckResult) => `| ${name} | ${c.status} | ${cell(c.reason)} |`;
  const lines = [
    "# Prove evidence",
    "",
    `- Base commit: \`${evidence.baseCommit}\``,
    `- Patch SHA-256: \`${evidence.patchSha256}\``,
    `- Implementation file: \`${input.implPath}\``,
    `- Test file: \`${input.testPath}\``,
    `- Overall: ${result.ok ? "proved" : "not proved"}`,
    "",
    "| Check | Result | Reason |",
    "| --- | --- | --- |",
  ];
  if (input.scope) {
    lines.push(`| scope | ${input.scope.reason} | ${cell(input.scope.detail)} |`);
  }
  lines.push(row("baseline", result.baseline), row("red", result.red), row("green", result.green));
  lines.push("", "Red failure message:", "", "```", result.red.failureMessage ?? "(none)", "```");
  lines.push("", "Commands run:", "");
  for (const c of [result.baseline, result.red, result.green]) {
    for (const command of c.commands) lines.push(`- \`${command}\``);
  }
  await writeFile(path.join(outDir, "evidence.md"), lines.join("\n") + "\n");
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
