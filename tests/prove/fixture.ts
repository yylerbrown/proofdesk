// Throwaway git repositories for the prove tests.
//
// Each fixture is a tiny project in a temp directory: one buggy module, one
// other module, one existing passing test and a vitest config. vitest comes
// from this project's node_modules through a symlink.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
export const IMPL = "src/clamp.js";
export const TEST = "tests/clamp-high.test.js";

// The bug: a value above the range comes back as the low end.
export const BUGGY_CLAMP = `export function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return lo;
  return n;
}
`;

export const FIXED_CLAMP = BUGGY_CLAMP.replace("if (n > hi) return lo;", "if (n > hi) return hi;");

export const EXISTING_TEST = `import { expect, it } from "vitest";
import { clamp } from "../src/clamp.js";

it("keeps a value inside the range", () => {
  expect(clamp(5, 0, 10)).toBe(5);
});

it("raises a value below the range", () => {
  expect(clamp(-1, 0, 10)).toBe(0);
});
`;

export const REGRESSION_TEST = `import { expect, it } from "vitest";
import { clamp } from "../src/clamp.js";

it("lowers a value above the range to the high end", () => {
  expect(clamp(11, 0, 10)).toBe(10);
});
`;

const BASE_FILES: Record<string, string> = {
  "package.json": '{ "type": "module", "private": true }\n',
  ".gitignore": "node_modules\n",
  "vitest.config.js": 'export default { test: { include: ["tests/**/*.test.js"] } };\n',
  "src/clamp.js": BUGGY_CLAMP,
  "src/other.js": "export const other = 1;\n",
  "tests/clamp.test.js": EXISTING_TEST,
};

export interface Fixture {
  tmp: string; // holds the repo, edit copies and patch files
  repo: string;
  base: string; // the commit sha of the base
}

// Fixed identity and no signing, so commits work on a machine with no git setup.
const GIT_ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
const NO_SIGN = ["-c", "commit.gpgsign=false"];

export function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", [...GIT_ID, ...NO_SIGN, ...args], { cwd, encoding: "utf8" });
}

export function writeFiles(dir: string, files: Record<string, string | Buffer>): void {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(dir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export function makeFixture(): Fixture {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "prove-fixture-"));
  const repo = path.join(tmp, "repo");
  mkdirSync(repo);
  writeFiles(repo, BASE_FILES);
  gitIn(repo, ["init", "--quiet", "-b", "main"]);
  gitIn(repo, ["add", "-A"]);
  gitIn(repo, ["commit", "--quiet", "-m", "base"]);
  symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(repo, "node_modules"), "dir");
  const base = gitIn(repo, ["rev-parse", "HEAD"]).trim();
  return { tmp, repo, base };
}

export function removeFixture(fx: Fixture): void {
  rmSync(fx.tmp, { recursive: true, force: true });
}

let editCounter = 0;

// Makes a patch with git: copy the base, let `edit` change files, stage
// everything and write `git diff --cached --binary -M` to a file.
export function makePatch(fx: Fixture, edit: (dir: string) => void): string {
  editCounter += 1;
  const dir = path.join(fx.tmp, `edit-${editCounter}`);
  gitIn(fx.tmp, ["clone", "--quiet", fx.repo, dir]);
  edit(dir);
  gitIn(dir, ["add", "-A"]);
  const patch = gitIn(dir, ["diff", "--cached", "--binary", "-M", "HEAD"]);
  rmSync(dir, { recursive: true, force: true });
  return writePatch(fx, patch);
}

// Writes a hand-made patch text to a file and returns its path.
export function writePatch(fx: Fixture, text: string): string {
  editCounter += 1;
  const file = path.join(fx.tmp, `patch-${editCounter}.patch`);
  writeFileSync(file, text);
  return file;
}

// The usual edit: fix the module and add the regression test.
export function fixAndTest(dir: string, test = REGRESSION_TEST, impl = FIXED_CLAMP): void {
  writeFiles(dir, { [IMPL]: impl, [TEST]: test });
}

export function makeExecutable(dir: string, file: string): void {
  chmodSync(path.join(dir, file), 0o755);
}
