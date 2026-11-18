-- Why a connection ended, in the words the Connections page shows, such as "Ended when Sam
-- Helper stopped being an admin." It is set only when a role change ended the connection.
-- It stays empty when an admin pressed Revoke, and for connections ended before this column.
ALTER TABLE agent_connections ADD COLUMN revoked_reason TEXT;
