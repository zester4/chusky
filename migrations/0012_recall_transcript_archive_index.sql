BEGIN;

-- Owner + meeting hash provides a bounded, content-free lookup for encrypted
-- retained transcript segments without scanning the whole object catalog.
CREATE INDEX IF NOT EXISTS chusky_object_metadata_transcript_meeting_idx
  ON chusky_object_metadata (owner_user_id, (metadata->>'meetingHash'), object_id)
  WHERE object_kind = 'transcript_segment' AND lifecycle_status <> 'deleted';

COMMIT;
