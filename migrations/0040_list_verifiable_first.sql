-- The default list order now puts New tickets that say how to verify the fix before the other
-- open tickets: open first, then New with a check, then newest first. This index holds the
-- tickets that are not archived in that order, written exactly as the list's ORDER BY writes
-- it, so a page is still read in order and the reading stops once the page is full. It
-- replaces the index for the old default order, which nothing reads any more.

CREATE INDEX tickets_list_verifiable_first ON tickets (
  (status = 'resolved'),
  (status = 'new' AND fix_check IS NOT NULL) DESC,
  id DESC
) WHERE archived_at IS NULL;

DROP INDEX tickets_list_open_first;
