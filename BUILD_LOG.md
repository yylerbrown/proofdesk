# Build log

An honest record of each step: what was asked, what came back wrong or was changed, and the
pull request that carried it.

| Step            | What was asked                                                                                              | What came back wrong or was changed                                                                                                                                                                           | Pull request                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 0. Skeleton     | TypeScript strict project with Express, zod, SQLite and a migration runner, tests, lint, Dockerfile and CI. | Merged before this log existed, so there is no record of what was corrected along the way. The CI workflow targets Node 22 while local development uses Node 20, so the Node 22 path is only exercised in CI. | Merged directly, no pull request |
| 1. Method files | Working rules for assistants, this log, and a pull request template.                                        | Nothing went wrong. Checked that `AGENTS.md` is under 40 lines, that the files contain no em dashes, emojis or names, and that format, lint, typecheck, tests and build still pass.                           | This pull request                |
