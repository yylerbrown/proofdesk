-- The ticket list sorts by its column headers. Each index below holds the tickets that are not
-- archived in one column's sort, ending on the id, so a page is read in order, forwards or
-- backwards, and the reading stops once the page is full. Each expression is written exactly as
-- the list's ORDER BY writes it, so the database can match the two.

-- The key is the table's own order by id, and the time last updated already has its index in
-- 0032, so neither needs one here.

CREATE INDEX tickets_list_title ON tickets (title COLLATE NOCASE, id)
  WHERE archived_at IS NULL;

CREATE INDEX tickets_list_status ON tickets (
  (CASE status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END), id
) WHERE archived_at IS NULL;

CREATE INDEX tickets_list_owner ON tickets ((owner_name IS NULL), owner_name COLLATE NOCASE, id)
  WHERE archived_at IS NULL;

CREATE INDEX tickets_list_filed ON tickets (created_at, id)
  WHERE archived_at IS NULL;
