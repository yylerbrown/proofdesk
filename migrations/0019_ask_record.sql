-- What the owner records when asking the customer "Did this fix it?": what they tried, what
-- happened, their response to the customer's last No, and the evidence they relied on (JSON
-- list of evidence ids). The customer sees it with the question.
ALTER TABLE tickets ADD COLUMN ready_tried TEXT;
ALTER TABLE tickets ADD COLUMN ready_result TEXT;
ALTER TABLE tickets ADD COLUMN ready_response TEXT;
ALTER TABLE tickets ADD COLUMN ready_evidence TEXT;
