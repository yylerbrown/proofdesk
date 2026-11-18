// Command-line entry for the prove stage.
//
//   npx tsx ops/prove/cli.ts --base <sha> --patch <file> --impl <path> \
//     --test <path> --out <dir> [--repo <dir>] [--timeout <ms>]
//
// Exit code 0 only when the scope check accepts the patch and baseline, red
// and green all hold. One plain line is printed per check.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkRedGreen, DEFAULT_TIMEOUT_MS, type CheckResult } from "./redgreen.js";
import { isInside } from "./run.js";
import { checkScope } from "./scope.js";

const USAGE =
  "usage: cli --base <sha> --patch <file> --impl <path> --test <path> --out <dir> " +
  "[--repo <dir>] [--timeout <ms>]";

interface Options {
  base: string;
  patch: string;
  impl: string;
  test: string;
  out: string;
  repo: string;
  timeoutMs: number;
}

// Reads "--name value" pairs. Returns an error message instead of throwing.
export function parseArgs(argv: string[]): Options | string {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined) return USAGE;
    values.set(flag.slice(2), value);
  }
  const known = ["base", "patch", "impl", "test", "out", "repo", "timeout"];
  for (const name of values.keys()) {
    if (!known.includes(name)) return `unknown option --${name}\n${USAGE}`;
  }
  for (const name of ["base", "patch", "impl", "test", "out"]) {
    if (!values.get(name)) return `missing --${name}\n${USAGE}`;
  }
  const timeoutMs = Number(values.get("timeout") ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return "--timeout must be a whole number";
  return {
    base: values.get("base") as string,
    patch: values.get("patch") as string,
    impl: values.get("impl") as string,
    test: values.get("test") as string,
    out: path.resolve(values.get("out") as string),
    repo: path.resolve(values.get("repo") ?? process.cwd()),
    timeoutMs,
  };
}

// Runs every check and returns the exit code. `print` receives each line.
export async function main(argv: string[], print = console.log): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === "string") {
    print(options);
    return 2;
  }
  if (isInside(options.repo, options.out)) {
    print("--out must be outside the repository");
    return 2;
  }

  const scope = await checkScope({
    repo: options.repo,
    base: options.base,
    patchFile: options.patch,
    implPath: options.impl,
    testPath: options.test,
  });
  print(`scope: ${scope.accepted ? "accepted" : "rejected"} (${scope.reason}: ${scope.detail})`);
  if (!scope.accepted) {
    await mkdir(options.out, { recursive: true });
    const evidence = { ok: false, base: options.base, testPath: options.test, scope };
    await writeFile(path.join(options.out, "evidence.json"), JSON.stringify(evidence, null, 2));
    await writeFile(
      path.join(options.out, "evidence.md"),
      `# Prove evidence\n\nScope rejected: ${scope.reason} (${scope.detail}). No tests were run.\n`,
    );
    return 1;
  }

  const result = await checkRedGreen({
    repo: options.repo,
    base: options.base,
    patchFile: options.patch,
    implPath: options.impl,
    testPath: options.test,
    outDir: options.out,
    timeoutMs: options.timeoutMs,
    scope,
  });
  const line = (name: string, c: CheckResult) => print(`${name}: ${c.status} (${c.reason})`);
  line("baseline", result.baseline);
  line("red", result.red);
  line("green", result.green);
  print(`evidence: ${path.join(options.out, "evidence.md")}`);
  return result.ok ? 0 : 1;
}

// Run only when this file is the program, not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 2;
    },
  );
}
