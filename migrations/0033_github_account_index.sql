-- Finding a person by their GitHub user number, for the team list that the ticket page shows
-- when a ticket is handed on: the server settings name team members and admins by that number.
-- Without this index the lookup read every account, one for each person who ever signed in.
CREATE INDEX account_provider_account_idx ON "account" ("providerId", "accountId");
