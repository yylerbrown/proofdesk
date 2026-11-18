-- Every row an agent's request adds to its activity first prunes rows older than 30 days. An
-- index on the row's time lets that prune find the old rows without reading the whole table.
CREATE INDEX agent_activity_created ON agent_activity (created_at);
