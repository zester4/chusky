BEGIN;

CREATE TABLE IF NOT EXISTS chusky_storage_metric_sample (
  instance_id UUID NOT NULL,
  batch_id BIGINT NOT NULL CHECK (batch_id > 0),
  family TEXT NOT NULL CHECK (family IN (
    'session', 'tasks', 'missions', 'channels', 'approvals', 'scheduling',
    'memory', 'meetings', 'runs', 'assets', 'coordination', 'other', 'mixed'
  )),
  observed_at TIMESTAMPTZ NOT NULL,
  commands BIGINT NOT NULL CHECK (commands >= 0),
  errors BIGINT NOT NULL CHECK (errors >= 0 AND errors <= commands),
  request_bytes BIGINT NOT NULL CHECK (request_bytes >= 0),
  response_bytes BIGINT NOT NULL CHECK (response_bytes >= 0),
  duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0),
  max_value_bytes BIGINT NOT NULL CHECK (max_value_bytes >= 0),
  PRIMARY KEY (instance_id, batch_id, family)
);

CREATE INDEX IF NOT EXISTS chusky_storage_metric_sample_observed_at_idx
  ON chusky_storage_metric_sample (observed_at);

COMMIT;
