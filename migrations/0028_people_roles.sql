-- Roles chosen in the product, on the People page, for people who signed in with GitHub.
-- The server settings ADMIN_GITHUB_IDS and TEAM_GITHUB_IDS still come first: a person named
-- there keeps that role whatever this table says. Everyone else without a row is a customer.

-- One row per person whose role an admin has chosen.
CREATE TABLE people_roles (
  person_id TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('customer', 'team', 'admin')),
  updated_at TEXT NOT NULL
);

-- One row per change of role: when, who changed whom, from what to what. The names are kept
-- as they were at the time, like the author name on a reply. These rows are never changed or
-- removed, like the ticket history.
CREATE TABLE role_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,
  person_name TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_by_name TEXT NOT NULL,
  from_role TEXT NOT NULL CHECK (from_role IN ('customer', 'team', 'admin')),
  to_role TEXT NOT NULL CHECK (to_role IN ('customer', 'team', 'admin')),
  created_at TEXT NOT NULL
);

CREATE TRIGGER role_changes_no_update
BEFORE UPDATE ON role_changes
BEGIN
  SELECT RAISE(ABORT, 'role_changes is append-only: rows cannot be updated');
END;

CREATE TRIGGER role_changes_no_delete
BEFORE DELETE ON role_changes
BEGIN
  SELECT RAISE(ABORT, 'role_changes is append-only: rows cannot be deleted');
END;
