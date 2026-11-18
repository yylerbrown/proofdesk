// Small helpers shared by the prove stage: run a command and make a
// throwaway checkout of a repository at one commit.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CommandResult {
  command: string; // the command as one readable line, for the evidence report
  exitCode: number | null; // null when the process was killed
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

// The environment every command gets. It is built from scratch so that no
// token or secret from the caller's environment reaches the candidate code.
export function cleanEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: os.tmpdir(),
    TMPDIR: os.tmpdir(),
    LANG: "C",
    CI: "true",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

// Runs one program with an argument array (never through a shell).
// The child gets its own process group, so on timeout the whole group is
// killed, including any worker processes the test runner started.
export function runCommand(
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const command = [program, ...args].join(" ");
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, env: cleanEnv(), detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ command, exitCode: null, timedOut, stdout, stderr: stderr + err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, exitCode: code, timedOut, stdout, stderr });
    });
  });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL"); // a negative pid means the whole group
  } catch {
    // the group is already gone
  }
}

const GIT_TIMEOUT_MS = 60_000;

// Runs git and throws if it fails. Used for steps that must not fail.
export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand("git", args, cwd, GIT_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new Error(`${result.command} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// Runs git and returns the result without throwing.
export function tryGit(cwd: string, args: string[]): Promise<CommandResult> {
  return runCommand("git", args, cwd, GIT_TIMEOUT_MS);
}

export interface Workspace {
  root: string; // temporary directory that holds everything for one run
  dir: string; // the checkout itself, inside root
}

// Makes a fresh checkout of `repo` at `base` in a new temporary directory.
// `git clone --shared` borrows the objects of the source repository, so it is
// fast and does not change the source repository.
// Known shortcut: node_modules of the source repository is symlinked in
// instead of installed, so every workspace uses the same packages.
export async function makeWorkspace(repo: string, base: string): Promise<Workspace> {
  // realpath, because on macOS the temp folder is a symlink and vitest
  // reports the real path of each test file.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prove-")));
  const dir = path.join(root, "repo");
  await git(root, ["clone", "--quiet", "--shared", "--no-checkout", repo, dir]);
  await git(dir, ["checkout", "--quiet", "--detach", base]);
  const modules = path.join(repo, "node_modules");
  if (existsSync(modules)) {
    await symlink(modules, path.join(dir, "node_modules"), "dir");
  }
  return { root, dir };
}

// Deletes a workspace. fs.rm removes the node_modules symlink itself and does
// not follow it into the source repository.
export async function removeWorkspace(ws: Workspace): Promise<void> {
  await rm(ws.root, { recursive: true, force: true });
}

// True when `child` is `parent` or somewhere inside it.
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  const outside = rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
  return !outside;
}
