// Scope check: does a patch stay inside its allowlist?
//
// The allowlist is one existing implementation file that may be modified and
// one new test file that may be added. Everything is decided by git itself:
// the patch is applied to a fresh checkout and the staged result is read back
// with `git diff --cached`, so the patch headers alone are never trusted.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeWorkspace, removeWorkspace, tryGit, type Workspace } from "./run.js";

export const MAX_PATCH_BYTES = 128 * 1024;
export const MAX_CHANGED_LINES = 150;

export type ScopeReason =
  | "accepted"
  | "bad-allowlist"
  | "patch-too-large"
  | "empty-patch"
  | "unsafe-path"
  | "patch-does-not-apply"
  | "protected-file"
  | "deleted-file"
  | "renamed-file"
  | "binary-file"
  | "symlink"
  | "mode-change"
  | "modifies-existing-test"
  | "not-allowed-path"
  | "missing-test"
  | "missing-impl-change"
  | "too-many-lines"
  | "focused-or-skipped-test";

export interface ScopeInput {
  repo: string; // the repository that holds the base commit
  base: string; // the commit the patch is made against
  patchFile: string;
  implPath: string; // the one existing file that may be modified
  testPath: string; // the one new test file that may be added
}

export interface ScopeResult {
  accepted: boolean;
  reason: ScopeReason;
  detail: string;
  files: string[]; // paths the staged diff touches (empty if it never got that far)
  changedLines: number;
}

// One line of `git diff --cached --raw`: modes, status letter and path(s).
interface RawEntry {
  oldMode: string;
  newMode: string;
  status: string; // A added, M modified, D deleted, R renamed, C copied, T type change
  path: string;
}

// One line of `git diff --cached --numstat`.
interface LineCount {
  added: number;
  deleted: number;
  binary: boolean;
}

const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
];

// Files a patch may never touch, even when the allowlist names them.
export function isProtected(file: string): boolean {
  const name = path.posix.basename(file);
  if (name === "package.json") return true;
  if (LOCKFILES.includes(name)) return true;
  if (file.startsWith(".github/")) return true;
  if (name.startsWith(".")) return true; // .eslintrc, .npmrc, .prettierrc, .env and so on
  if (name.startsWith("tsconfig") && name.endsWith(".json")) return true;
  if (/\.config\.[a-z]+$/.test(name)) return true; // vitest.config.ts, eslint.config.js
  return false;
}

// A test file, or anything in a test folder (helpers included).
export function isTestFile(file: string): boolean {
  const name = path.posix.basename(file);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return true;
  const parts = file.split("/");
  return parts.includes("tests") || parts.includes("__tests__");
}

// Absolute paths and any ".." segment are refused.
export function isUnsafePath(file: string): boolean {
  if (file.startsWith("/") || /^[A-Za-z]:/.test(file)) return true;
  return file.split(/[/\\]/).includes("..");
}

// Focused or skipped tests would make the red/green runs meaningless.
const FOCUS_OR_SKIP = /\.(only|skip|skipIf|runIf|todo)\s*\(/;

export async function checkScope(input: ScopeInput): Promise<ScopeResult> {
  const reject = (reason: ScopeReason, detail: string, files: string[] = [], changedLines = 0) => ({
    accepted: false,
    reason,
    detail,
    files,
    changedLines,
  });

  const { implPath, testPath } = input;
  if (implPath === testPath) return reject("bad-allowlist", "impl and test are the same path");
  if (isUnsafePath(implPath) || isUnsafePath(testPath)) {
    return reject("bad-allowlist", "allowlist path is absolute or uses ..");
  }
  if (!isTestFile(testPath) || isTestFile(implPath)) {
    return reject("bad-allowlist", "test path must be a test file and impl path must not be");
  }

  const patch = await readFile(input.patchFile);
  if (patch.length > MAX_PATCH_BYTES) {
    return reject("patch-too-large", `${patch.length} bytes, limit ${MAX_PATCH_BYTES}`);
  }

  const ws = await makeWorkspace(input.repo, input.base);
  try {
    return await checkInWorkspace(ws, input, patch.length, reject);
  } finally {
    await removeWorkspace(ws);
  }
}

async function checkInWorkspace(
  ws: Workspace,
  input: ScopeInput,
  patchBytes: number,
  reject: (reason: ScopeReason, detail: string, files?: string[], lines?: number) => ScopeResult,
): Promise<ScopeResult> {
  const { implPath, testPath } = input;
  const patchFile = path.resolve(input.patchFile);

  // The allowlist must match the base: impl exists there, test does not.
  const implAtBase = await tryGit(ws.dir, ["cat-file", "-e", `HEAD:${implPath}`]);
  if (implAtBase.exitCode !== 0) return reject("bad-allowlist", `${implPath} is not in the base`);
  const testAtBase = await tryGit(ws.dir, ["cat-file", "-e", `HEAD:${testPath}`]);
  if (testAtBase.exitCode === 0) {
    return reject("modifies-existing-test", `${testPath} already exists in the base`);
  }

  // Before applying, ask git which paths the patch names. With -p0 git keeps
  // the names exactly as written, so "/etc/x" and "b/../x" stay visible.
  const listed = await tryGit(ws.dir, ["apply", "--numstat", "-z", patchFile]);
  if (listed.exitCode !== 0) return reject("patch-does-not-apply", listed.stderr.trim());
  const names = namesFromNumstat(listed.stdout);
  if (names.length === 0) return reject("empty-patch", "the patch changes no file");
  // git cannot read some git-style headers with -p0 (a mode-only change, for
  // one); then the -p1 names above are all there is to check.
  const raw = await tryGit(ws.dir, ["apply", "-p0", "--numstat", "-z", patchFile]);
  if (raw.exitCode === 0) names.push(...namesFromNumstat(raw.stdout));
  const unsafe = names.find(isUnsafePath);
  if (unsafe !== undefined) return reject("unsafe-path", unsafe);

  const check = await tryGit(ws.dir, ["apply", "--check", patchFile]);
  if (check.exitCode !== 0) return reject("patch-does-not-apply", check.stderr.trim());
  const applied = await tryGit(ws.dir, ["apply", "--index", patchFile]);
  if (applied.exitCode !== 0) return reject("patch-does-not-apply", applied.stderr.trim());

  // From here on only the staged result counts.
  const rawOut = await tryGit(ws.dir, ["diff", "--cached", "--raw", "-z", "-M", "HEAD"]);
  const numOut = await tryGit(ws.dir, ["diff", "--cached", "--numstat", "-z", "--no-renames"]);
  const entries = parseRaw(rawOut.stdout);
  const counts = parseNumstat(numOut.stdout);
  const files = entries.map((e) => e.path);
  let changedLines = 0;
  for (const count of counts.values()) changedLines += count.added + count.deleted;
  const no = (reason: ScopeReason, detail: string) => reject(reason, detail, files, changedLines);

  if (entries.length === 0) return no("empty-patch", "the patch changes no file");

  for (const e of entries) {
    if (isProtected(e.path)) return no("protected-file", e.path);
    if (e.status === "D") return no("deleted-file", e.path);
    if (e.status === "R" || e.status === "C") return no("renamed-file", e.path);
    if (e.oldMode === "120000" || e.newMode === "120000") return no("symlink", e.path);
    if (e.status === "T") return no("mode-change", e.path);
    if (e.status === "M" && e.oldMode !== e.newMode) return no("mode-change", e.path);
    if (e.status === "A" && e.newMode !== "100644") return no("mode-change", e.path);
    if (counts.get(e.path)?.binary) return no("binary-file", e.path);
    if (e.status === "M" && isTestFile(e.path)) return no("modifies-existing-test", e.path);
    const allowed =
      (e.status === "M" && e.path === implPath) || (e.status === "A" && e.path === testPath);
    if (!allowed) return no("not-allowed-path", `${e.status} ${e.path}`);
  }

  if (!files.includes(testPath)) return no("missing-test", `${testPath} is not added`);
  if (!files.includes(implPath)) return no("missing-impl-change", `${implPath} is not changed`);
  if (changedLines > MAX_CHANGED_LINES) {
    return no("too-many-lines", `${changedLines} changed lines, limit ${MAX_CHANGED_LINES}`);
  }

  // Read the new test as git staged it, not as the patch text shows it.
  const staged = await tryGit(ws.dir, ["show", `:${testPath}`]);
  const match = FOCUS_OR_SKIP.exec(staged.stdout);
  if (match) return no("focused-or-skipped-test", `${testPath} contains ${match[0]}`);

  return {
    accepted: true,
    reason: "accepted",
    detail: `${patchBytes} bytes, ${changedLines} changed lines`,
    files,
    changedLines,
  };
}

// `git apply --numstat -z` prints "added<TAB>deleted<TAB>path<NUL>". For a
// rename the path field is empty and the old and new names follow, each
// ended by NUL.
function namesFromNumstat(out: string): string[] {
  const tokens = out.split("\0");
  const names: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    i += 1;
    if (token === "") continue;
    const fields = token.split("\t");
    const name = fields[2] ?? "";
    if (name !== "") {
      names.push(name);
    } else {
      names.push(tokens[i] ?? "", tokens[i + 1] ?? "");
      i += 2;
    }
  }
  return names;
}

// `git diff --raw -z` prints ":oldmode newmode oldsha newsha status<NUL>path<NUL>"
// and for a rename or copy a second path follows.
function parseRaw(out: string): RawEntry[] {
  const tokens = out.split("\0");
  const entries: RawEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const header = tokens[i] ?? "";
    i += 1;
    if (!header.startsWith(":")) continue;
    const [oldMode = "", newMode = "", , , statusField = ""] = header.slice(1).split(" ");
    const status = statusField.charAt(0);
    let file = tokens[i] ?? "";
    i += 1;
    if (status === "R" || status === "C") {
      file = tokens[i] ?? ""; // report the new name
      i += 1;
    }
    entries.push({ oldMode, newMode, status, path: file });
  }
  return entries;
}

// `git diff --numstat -z --no-renames` prints "added<TAB>deleted<TAB>path<NUL>",
// with "-" for both counts on a binary file.
function parseNumstat(out: string): Map<string, LineCount> {
  const counts = new Map<string, LineCount>();
  for (const token of out.split("\0")) {
    if (token === "") continue;
    const [added = "0", deleted = "0", file = ""] = token.split("\t");
    const binary = added === "-" || deleted === "-";
    counts.set(file, {
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    });
  }
  return counts;
}
