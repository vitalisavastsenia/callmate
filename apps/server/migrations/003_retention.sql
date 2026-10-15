-- Keep a stable completion time independent of later metadata updates/deletion.
ALTER TABLE call_attempts ADD COLUMN terminal_at TEXT;
UPDATE call_attempts
SET terminal_at = COALESCE(
  (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(value, '$.occurredAt'))
   FROM call_events
   WHERE attempt_id = call_attempts.id
     AND json_extract(value, '$.type') = 'call.status'
     AND json_extract(value, '$.payload.callState') IN ('ended', 'busy', 'no_answer', 'failed')
   ORDER BY sequence LIMIT 1),
  strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(snapshot, '$.updatedAt'))
)
WHERE active = 0;
CREATE INDEX expired_conversations ON call_attempts (terminal_at, id)
WHERE active = 0 AND json_extract(snapshot, '$.conversationData') = 'retained';
