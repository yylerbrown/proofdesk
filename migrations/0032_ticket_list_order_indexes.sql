-- The ticket list reads one page of the tickets that are not archived, in one of three orders.
-- Without an index for the order, every list read the whole table and sorted it. Each index
-- below holds only the tickets that are not archived, in one order the list offers, so a page
-- is read in order and the reading stops once the page is full.

-- The default order: open tickets newest first, then resolved ones newest first.
CREATE INDEX tickets_list_open_first ON tickets ((status = 'resolved'), id DESC)
  WHERE archived_at IS NULL;

-- Oldest first is the table's own order by id, so it needs no index of its own.

-- Recently updated first.
CREATE INDEX tickets_list_updated ON tickets (updated_at DESC, id DESC)
  WHERE archived_at IS NULL;
