CREATE TABLE image_contexts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
