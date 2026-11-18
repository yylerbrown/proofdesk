-- When a pending notice may next be tried. Empty until its first try. Claiming a notice to send
-- moves this time forward, by more than one try can take, so no other process or timer tick
-- picks up the same notice while it is being sent. A failed try leaves it there, as the wait
-- before the next one.
ALTER TABLE email_outbox ADD COLUMN next_attempt_at TEXT;
