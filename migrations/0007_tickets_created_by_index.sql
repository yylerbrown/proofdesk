-- A customer's list asks for the tickets one person filed. Without an index that reads
-- every ticket.
CREATE INDEX idx_tickets_created_by ON tickets (created_by);
