-- Emergency dispatch job store (D1)

DROP TABLE IF EXISTS jobs;

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  tool_call_id     TEXT,            -- Vapi's tool call id; used for retry dedupe
  created_at       INTEGER NOT NULL,
  type             TEXT NOT NULL,   -- emergency | booking
  caller_name      TEXT,
  callback_number  TEXT,
  address          TEXT,
  suburb           TEXT,
  issue            TEXT,
  severity         TEXT,            -- active_damage | contained | no_water
  preferred_window TEXT,            -- morning | afternoon | either
  status           TEXT NOT NULL,   -- new | claimed | booked
  accept_token     TEXT UNIQUE,
  claimed_by       TEXT,
  claimed_at       INTEGER,
  escalation_level INTEGER DEFAULT 0,  -- 0 none, 1 second tech, 2 owner rung
  client_id        TEXT,
  result           TEXT             -- the line the agent speaks back
);

CREATE UNIQUE INDEX idx_jobs_toolcall ON jobs(tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX idx_jobs_open ON jobs(type, status, escalation_level, created_at);
CREATE INDEX idx_jobs_recent ON jobs(created_at DESC);
