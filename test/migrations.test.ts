import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "../src/storage/migrations/index.ts";
import { createTestRuntime, T0, tempDbPath } from "./helpers.ts";

/** Schema version shipped in the first published release (0.1.0). */
const PUBLISHED_SCHEMA_VERSION = 3;

function schemaOf(path: string): unknown[] {
  const db = new DatabaseSync(path);
  try {
    return db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
      .all();
  } finally {
    db.close();
  }
}

/** Builds a database at the published schema version with rows in every table. */
function createPublishedDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    for (const migration of MIGRATIONS) {
      if (migration.version > PUBLISHED_SCHEMA_VERSION) break;
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.prepare(
      `INSERT INTO invocations (id, workflow_name, workflow_version, status, available_at,
         idempotency_key, schedule_id, scheduled_at, scheduled_from, input_json, output_json,
         error_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "inv-1", "hello", "1", "completed", T0, "key-1", "hourly", T0, T0 - 3_600_000,
      JSON.stringify({ name: "jugyo" }), JSON.stringify({ greeting: "hi" }), null, T0, T0 + 10,
    );
    db.prepare(
      `INSERT INTO journal_entries (invocation_id, seq, kind, name, status, attempt,
         output_json, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("inv-1", 0, "run", "greet", "completed", 1, JSON.stringify("hi"), T0, T0 + 5);
    db.prepare(
      `INSERT INTO schedules (id, workflow_name, input_json, every_ms, next_run_at,
         schedule_type, daily_at, timezone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("hourly", "hello", JSON.stringify({}), 3_600_000, T0 + 3_600_000, "interval", null, null, T0, T0);
  } finally {
    db.close();
  }
}

describe("migrations", () => {
  it("upgrades a published-schema database to the latest schema and keeps its data", (t) => {
    const upgradedPath = tempDbPath(t);
    createPublishedDatabase(upgradedPath);

    const harness = createTestRuntime({ workflows: [], dbPath: upgradedPath });
    try {
      assert.equal(harness.store.schemaVersion(), LATEST_SCHEMA_VERSION);

      const invocation = harness.runtime.getInvocation("inv-1");
      assert.equal(invocation.status, "completed");
      assert.equal(invocation.idempotencyKey, "key-1");
      assert.equal(invocation.scheduledFrom, T0 - 3_600_000);
      assert.deepEqual(invocation.input, { name: "jugyo" });
      assert.deepEqual(invocation.output, { greeting: "hi" });

      const journal = harness.runtime.getJournal("inv-1");
      assert.equal(journal.length, 1);
      assert.equal(journal[0].name, "greet");
      assert.equal(journal[0].output, "hi");

      const schedule = harness.runtime.getSchedule("hourly");
      assert.equal(schedule.everyMs, 3_600_000);
      assert.equal(schedule.scheduleType, "interval");
    } finally {
      harness.close();
    }

    const freshPath = tempDbPath(t);
    createTestRuntime({ workflows: [], dbPath: freshPath }).close();
    assert.deepEqual(schemaOf(upgradedPath), schemaOf(freshPath));
  });
});
