# Prove stage

Before a proposed change is opened for review, this stage checks the patch and proves the fix with
plain commands. No AI is called here, and the commands get a minimal environment (`PATH`, a temp
`HOME`, `LANG`, `CI`) so no token or secret from the caller reaches the candidate code.

## Run it

```sh
npx tsx ops/prove/cli.ts --base <sha> --patch <file> --impl <path> --test <path> --out <dir> \
  [--repo <dir>] [--timeout <ms>]
```

`node --import tsx ops/prove/cli.ts ...` does the same. There is no build step for `ops/`, so the
CLI runs through `tsx`, which is already a dev dependency.

- `--repo` is the repository that holds the base commit. It defaults to the current folder.
- `--impl` is the one existing file the patch may modify. `--test` is the one new test file it may
  add.
- `--out` must be outside the repository. It receives `evidence.json` and `evidence.md`.
- `--timeout` is the limit for each test run, in milliseconds. The default is 120000.

It prints one line per check. The exit code is 0 only when the scope check accepts the patch and
baseline, red and green all hold. It is 1 when a check does not hold and 2 for bad options.

## What it checks

1. **Scope** (`scope.ts`). The patch is applied with `git apply --index` to a fresh clone of the
   base, and the staged result is read back with `git diff --cached --raw` and `--numstat`. The
   patch headers alone are never trusted. Rejected, each with its own reason code: a patch over
   128 KiB, an absolute path or a `..` segment, a patch that does not apply, `package.json`, a
   lockfile, anything under `.github/`, a config file, a deleted or renamed file, a symlink, a mode
   change, a binary file, a change to an existing test, any path other than the two allowlisted
   ones, a missing test or missing implementation change, more than 150 changed lines, and a new
   test containing `.only(`, `.skip(`, `.skipIf(`, `.runIf(` or `.todo(`.
2. **Red/green** (`redgreen.ts`), each in its own clean temporary clone:
   - Baseline: the base alone, the existing suite passes.
   - Red: the base plus only the new test (`git apply --include=<test>`), that test run alone fails
     with an assertion failure. A test file that does not load (syntax error, bad import), no tests
     found, a timeout or a crash is `inconclusive`, not red.
   - Green: the base plus the whole patch, the new test passes alone and the full suite passes and
     includes it.

vitest's JSON reporter is how an assertion failure is told apart from other failures: a file that
did not load has a file-level message, and an assertion failure starts with `AssertionError`.

## Known shortcuts

- **node_modules is shared.** Each temporary clone gets a symlink to the base repository's
  `node_modules` instead of its own install. This keeps a run to a few seconds. It means a patch
  cannot change dependencies (the scope check refuses `package.json` and lockfiles anyway), and
  every run uses whatever is installed in the base checkout, which must match the base commit.
- **The clone borrows objects.** `git clone --shared` points the temporary clone at the source
  repository's objects, so it is fast and the source repository is not changed.
- **Timeouts kill the whole process group**, so test workers started by vitest stop too. This uses
  POSIX process groups, so it works on Linux and macOS, not on Windows.

## Files

- `run.ts`: running commands with argument arrays and making temporary clones.
- `scope.ts`, `redgreen.ts`, `cli.ts`: the three parts above.
- Tests are in `tests/prove/`. They build tiny throwaway git repositories as fixtures.
