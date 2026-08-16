PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('mp3', 'mp4')),
  quality INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  stage TEXT NOT NULL DEFAULT 'queued',
  object_key TEXT,
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  cache_key TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_cache_key ON jobs(cache_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_cache
  ON jobs(cache_key)
  WHERE status IN ('queued', 'processing');
