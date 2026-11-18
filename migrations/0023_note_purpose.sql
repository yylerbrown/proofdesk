-- What an internal note is for: an ordinary note, wording an assistant suggests the team send to
-- the customer, or an assistant asking the owner to review its evidence. Only a suggested reply
-- is offered for publishing, so a review request never reaches the customer by one click.
ALTER TABLE ticket_entries ADD COLUMN purpose TEXT NOT NULL DEFAULT 'note'
  CHECK (purpose IN ('note', 'suggested_reply', 'review_request'));
