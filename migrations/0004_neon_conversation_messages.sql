-- Full conversation history lives in Neon; Redis keeps only a recent hot window.
CREATE TABLE IF NOT EXISTS chusky_conversation_message (
  user_id BIGINT NOT NULL CHECK (user_id >= 0),
  message_id TEXT NOT NULL CHECK (message_id ~ '^[A-Za-z0-9:_-]{1,180}$'),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(content) <= 12000),
  source_id TEXT CHECK (source_id IS NULL OR length(source_id) <= 160),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS chusky_conversation_message_recent_idx
  ON chusky_conversation_message (user_id, created_at DESC, message_id DESC);
