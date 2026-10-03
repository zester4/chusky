-- Neon owns the authorization and lifecycle record; R2 stores object bytes.
BEGIN;

CREATE TABLE IF NOT EXISTS chusky_object_metadata (
  owner_user_id BIGINT NOT NULL CHECK (owner_user_id >= 0),
  object_id TEXT NOT NULL CHECK (object_id ~ '^obj_[A-Za-z0-9_-]{1,120}$'),
  object_kind TEXT NOT NULL CHECK (object_kind IN ('image','file','transcript_segment','agent_run_archive','temporary_media','other')),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 512),
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('pending','available','deleting','deleted','failed')),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 160),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  encryption_version TEXT CHECK (encryption_version IS NULL OR length(encryption_version) <= 80),
  retention_expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, object_id),
  CHECK (lifecycle_status <> 'available' OR sha256 IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS chusky_object_metadata_owner_kind_idx
  ON chusky_object_metadata (owner_user_id, object_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS chusky_object_metadata_expiry_idx
  ON chusky_object_metadata (retention_expires_at, owner_user_id, object_id)
  WHERE retention_expires_at IS NOT NULL AND lifecycle_status IN ('pending','available','deleting','failed');

COMMIT;
