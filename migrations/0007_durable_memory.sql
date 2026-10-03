-- Durable memory is separate from the hot Redis session.  Every row is scoped
-- to an explicit memory scope and every searchable fact retains provenance.
BEGIN;

CREATE TABLE IF NOT EXISTS chusky_memory_scopes (
  id text PRIMARY KEY,
  owner_user_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('personal','organization','team','project','client','meeting','conversation','channel')),
  external_id text NOT NULL,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, external_id)
);

CREATE TABLE IF NOT EXISTS chusky_memory_grants (
  scope_id text NOT NULL REFERENCES chusky_memory_scopes(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('user','agent','service')),
  subject_id text NOT NULL,
  permissions text[] NOT NULL DEFAULT ARRAY['read'],
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS chusky_memory_sources (
  id text PRIMARY KEY,
  owner_user_id bigint NOT NULL,
  source_type text NOT NULL,
  source_ref text,
  content_hash text,
  captured_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, source_type, source_ref)
);

CREATE TABLE IF NOT EXISTS chusky_memory_entities (
  id text PRIMARY KEY,
  owner_user_id bigint NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('person','organization','team','project','client','product','tool','meeting')),
  canonical_name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, entity_type, canonical_name)
);

CREATE TABLE IF NOT EXISTS chusky_memory_items (
  id text PRIMARY KEY,
  owner_user_id bigint NOT NULL,
  scope_id text NOT NULL REFERENCES chusky_memory_scopes(id) ON DELETE CASCADE,
  entity_id text REFERENCES chusky_memory_entities(id) ON DELETE SET NULL,
  source_id text REFERENCES chusky_memory_sources(id) ON DELETE SET NULL,
  category text NOT NULL,
  memory_key text NOT NULL,
  value text NOT NULL,
  confidence real NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  sensitivity text NOT NULL CHECK (sensitivity IN ('normal','sensitive')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted','needs_review')),
  supersedes_id text REFERENCES chusky_memory_items(id) ON DELETE SET NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  review_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Earlier drafts used a uniqueness constraint across every status, which
-- prevented a memory key from acquiring a second historical version. Remove
-- that legacy constraint if this migration is being repaired in place.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid = 'chusky_memory_items'::regclass
    AND c.contype = 'u'
    AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
         FROM unnest(c.conkey) AS k(attnum)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
        = ARRAY['memory_key','owner_user_id','scope_id','status']::text[]
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE chusky_memory_items DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS chusky_memory_edges (
  id text PRIMARY KEY,
  owner_user_id bigint NOT NULL,
  scope_id text NOT NULL REFERENCES chusky_memory_scopes(id) ON DELETE CASCADE,
  from_entity_id text NOT NULL REFERENCES chusky_memory_entities(id) ON DELETE CASCADE,
  relation text NOT NULL,
  to_entity_id text NOT NULL REFERENCES chusky_memory_entities(id) ON DELETE CASCADE,
  source_id text REFERENCES chusky_memory_sources(id) ON DELETE SET NULL,
  confidence real NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, scope_id, from_entity_id, relation, to_entity_id, status)
);

CREATE TABLE IF NOT EXISTS chusky_memory_profiles (
  scope_id text NOT NULL REFERENCES chusky_memory_scopes(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  body text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, purpose)
);

CREATE TABLE IF NOT EXISTS chusky_memory_outbox (
  id bigserial PRIMARY KEY,
  memory_id text NOT NULL REFERENCES chusky_memory_items(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('upsert','delete')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chusky_memory_items_scope_idx ON chusky_memory_items(scope_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS chusky_memory_items_owner_idx ON chusky_memory_items(owner_user_id, category, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS chusky_memory_items_one_active_key_idx ON chusky_memory_items(owner_user_id, scope_id, memory_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS chusky_memory_items_review_idx ON chusky_memory_items(review_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS chusky_memory_edges_scope_idx ON chusky_memory_edges(scope_id, status, relation);
CREATE INDEX IF NOT EXISTS chusky_memory_outbox_ready_idx ON chusky_memory_outbox(available_at, completed_at, claimed_at);

COMMIT;
