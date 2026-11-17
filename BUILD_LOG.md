# Build log

An honest record of each step: what was asked, what came back wrong or was changed, and the
pull request that carried it.

| 7. Sign-in | GitHub sign-in through a standard library, roles from configuration, a defence against forged cross-site requests, and rate limits. | A browser click-through found the forged-request check refusing this site's own forms. An independent review then found five more, all fixed with tests: account linking let another GitHub account inherit a role, a tab in the return address led off-site, plain http was allowed in production, refreshed session cookies were dropped, and stylesheets went through the session lookup. | This pull request |
| 8. Follow-ups | After an outside opinion on the design: team members restore archived tickets, archiving asks first, migrations apply under one lock, an index. | The lock itself has no test: a first attempt at one passed with and without the fix, so it was removed. The check inside the transaction is tested. The collision was seen for real when two dev servers started together. | This pull request |
