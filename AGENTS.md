# Working rules for AI coding assistants

These rules apply to any AI coding assistant that changes this repository.

## How to work

- Work in small steps. One pull request per step, and keep each one short enough to read in
  one sitting.
- Every change comes with tests that would fail without it. Run the tests, then break the
  rule on purpose once to see the test fail, then restore it.
- Do not hand-roll replacements for standard libraries. Use zod for validation, the
  database driver for SQL, and the Node standard library for files and paths.
- Keep routes, services and database code in separate modules. Routes read the request and
  send the response. Services hold the rules and the transactions. Repositories hold the SQL.
- Write plain, boring code that someone new to TypeScript can read line by line. Prefer a
  few clear lines to a clever one.
- Run typecheck, lint, the full test suite and a build before every push.

## What never goes in the repository

- No secrets, tokens, passwords or real customer data. Use `.env.example` for variable
  names and safe defaults.
- No real names of people or companies.

## Writing

- Use plain sentences in prose. No emojis and no em dashes.
- Commit messages say what changed and why, in the imperative mood.

## Review

- The assistant that builds a change never merges, pushes to `main` or deploys. No assistant
  changes repository settings, secrets or branch protection.
- Checks gate every merge but one: typecheck, lint, format, the unit tests, the build and the
  browser journey pass on the exact commit being merged. The one is #1, merged while its
  restarted checks were still running; they passed two minutes later.
- Until 17:01 UTC on 18 November GitHub's CI ran those checks. Since then it cannot start jobs on
  the private working repository, so every merge from #96 on is decided by a local gate that runs
  the same commands, and the public copy's CI still runs them. `docs/SPEC.md` records both.
- In this build, under the owner's standing instruction, a separate coordinating assistant merged
  the pull requests and deployed the demo and the real site. The owner set the direction and made
  the design calls. Reviews came from other AI sessions and models, and no human reviewer read
  the pull requests.
- Say plainly in the pull request what was run and what was not. Do not claim something
  works unless it was run.
