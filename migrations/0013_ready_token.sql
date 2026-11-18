-- A fresh random token for each "Did this fix it?" question. The customer's answer must
-- carry the token of the question they were shown, so an old form cannot answer a newer
-- question. It is cleared whenever the question is withdrawn.
ALTER TABLE tickets ADD COLUMN ready_token TEXT;
