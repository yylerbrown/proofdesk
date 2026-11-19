-- A word index of every ticket's title and description, so the list's search finds words in any
-- order and in any form: "signing phone" finds "Cannot sign in on my phone". The porter tokenizer
-- folds word endings, and unicode61 with remove_diacritics folds case and accents. Each row's id
-- is the ticket's id.
CREATE VIRTUAL TABLE ticket_search USING fts5(
  title,
  description,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- The index is a second copy of ticket text. With this option on, a deleted row's words are
-- removed from the index's own pages, so a permanently deleted ticket leaves no word on disk.
INSERT INTO ticket_search (ticket_search, rank) VALUES ('secure-delete', 1);

-- Every ticket there is, archived ones too, because the Archived tab searches.
INSERT INTO ticket_search (rowid, title, description)
  SELECT id, title, description FROM tickets;

-- The index follows the tickets table on its own, so no code path can forget it.
CREATE TRIGGER ticket_search_after_insert AFTER INSERT ON tickets
BEGIN
  INSERT INTO ticket_search (rowid, title, description)
    VALUES (new.id, new.title, new.description);
END;

CREATE TRIGGER ticket_search_after_text_update AFTER UPDATE OF title, description ON tickets
BEGIN
  UPDATE ticket_search SET title = new.title, description = new.description
    WHERE rowid = new.id;
END;

CREATE TRIGGER ticket_search_after_delete AFTER DELETE ON tickets
BEGIN
  DELETE FROM ticket_search WHERE rowid = old.id;
END;
