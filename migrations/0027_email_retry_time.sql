-- When a pending notice may next be tried. Empty until its first try. Claiming a notice right
-- before its send moves this time forward by a lease far longer than one send can take, so no
-- other process or timer tick picks up the same notice while it is being sent. A failed try
-- then sets it to the wait before the next one.
ALTER TABLE email_outbox ADD COLUMN next_attempt_at TEXT;
