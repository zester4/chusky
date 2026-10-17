BEGIN;

-- Route attribution is intentionally separate from the family-only table so
-- existing deployments can apply this migration without rewriting or
-- invalidating their established storage metric primary key.
CREATE TABLE IF NOT EXISTS chusky_redis_route_metric_sample (
  instance_id UUID NOT NULL,
  batch_id BIGINT NOT NULL CHECK (batch_id > 0),
  route TEXT NOT NULL CHECK (length(route) BETWEEN 1 AND 120),
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
  PRIMARY KEY (instance_id, batch_id, route, family)
);

CREATE INDEX IF NOT EXISTS chusky_redis_route_metric_sample_observed_at_idx
  ON chusky_redis_route_metric_sample (observed_at);

COMMIT;
