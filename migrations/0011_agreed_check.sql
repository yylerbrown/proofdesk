-- "How will we know it's fixed?" in two versions. fix_check keeps the customer's own words.
-- agreed_check is the version a team member tightened, kept beside it.
ALTER TABLE tickets ADD COLUMN agreed_check TEXT;
