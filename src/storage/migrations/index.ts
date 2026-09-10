/**
 * Forward-only migrations, applied in order and tracked with `PRAGMA user_version`.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    sql: `
CREATE TABLE invocations (
  id                TEXT PRIMARY KEY,
  workflow_name     TEXT NOT NULL,
  workflow_version  TEXT NOT NULL,
  status            TEXT NOT NULL,
  available_at      INTEGER NOT NULL,
  idempotency_key   TEXT,
  schedule_id       TEXT,
  scheduled_at      INTEGER,
  input_json        TEXT NOT NULL,
  output_json       TEXT,
  error_json        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (workflow_name, idempotency_key)
) STRICT;

CREATE INDEX idx_invocations_runnable
  ON invocations(status, available_at);

CREATE INDEX idx_invocations_workflow
  ON invocations(workflow_name, created_at);

CREATE TABLE journal_entries (
  invocation_id  TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL,
  attempt        INTEGER NOT NULL DEFAULT 0,
  available_at   INTEGER,
  output_json    TEXT,
  error_json     TEXT,
  started_at     INTEGER,
  completed_at   INTEGER,
  PRIMARY KEY (invocation_id, seq)
) STRICT;

CREATE TABLE schedules (
  id                TEXT PRIMARY KEY,
  workflow_name     TEXT NOT NULL,
  input_json        TEXT NOT NULL,
  every_ms          INTEGER NOT NULL CHECK (every_ms > 0),
  next_run_at       INTEGER NOT NULL,
  catch_up          TEXT NOT NULL DEFAULT 'latest',
  max_catch_up      INTEGER NOT NULL DEFAULT 100,
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_scheduled_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_schedules_due
  ON schedules(enabled, next_run_at);

CREATE TABLE runtime_leases (
  name        TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
) STRICT;
`,
  },
  {
    version: 2,
    name: "daily-calendar-schedules",
    sql: `
ALTER TABLE schedules ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'interval'
  CHECK (schedule_type IN ('interval', 'daily'));
ALTER TABLE schedules ADD COLUMN daily_at TEXT;
ALTER TABLE schedules ADD COLUMN timezone TEXT;
`,
  },
  {
    version: 3,
    name: "scheduled-window-start",
    sql: `
ALTER TABLE invocations ADD COLUMN scheduled_from INTEGER;
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
