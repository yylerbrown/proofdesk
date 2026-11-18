-- From merged to confirmed. change_url is the link to the code change, pasted by the team
-- as evidence. try_url is the page on the live site where the customer can check the fix.
-- ready_at is set while the ticket waits for the customer's answer to "Did this fix it?".
ALTER TABLE tickets ADD COLUMN change_url TEXT;
ALTER TABLE tickets ADD COLUMN try_url TEXT;
ALTER TABLE tickets ADD COLUMN ready_at TEXT;
