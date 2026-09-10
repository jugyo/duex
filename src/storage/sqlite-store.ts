import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { decodePayload, encodePayload } from "../core/json.ts";
import { MiniRestateError } from "../core/errors.ts";
import type {
  CatchUpPolicy,
  InvocationRecord,
  InvocationStatus,
  JournalKind,
  JournalRecord,
  JournalStatus,
  Json,
  LeaseRecord,
  ScheduleRecord,
  SerializedError,
} from "../core/types.ts";
import type {
  InvocationFilter,
  InvocationPatch,
  JournalPatch,
  SchedulePatch,
  Store,
} from "./store.ts";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations/index.ts";

type Row = Record<string, unknown>;

function text(row: Row, column: string): string {
  return row[column] as string;
}

function nullableText(row: Row, column: string): string | null {
  const value = row[column];
  return value === null || value === undefined ? null : (value as string);
}

function int(row: Row, column: string): number {
  return Number(row[column]);
}

function nullableInt(row: Row, column: string): number | null {
  const value = row[column];
  return value === null || value === undefined ? null : Number(value);
}

function decodeError(text: string | null): SerializedError | null {
  return text === null ? null : (JSON.parse(text) as SerializedError);
}

function toInvocation(row: Row): InvocationRecord {
  return {
    id: text(row, "id"),
    workflowName: text(row, "workflow_name"),
    workflowVersion: text(row, "workflow_version"),
    status: text(row, "status") as InvocationStatus,
    availableAt: int(row, "available_at"),
    idempotencyKey: nullableText(row, "idempotency_key"),
    scheduleId: nullableText(row, "schedule_id"),
    scheduledAt: nullableInt(row, "scheduled_at"),
    scheduledFrom: nullableInt(row, "scheduled_from"),
    input: decodePayload(text(row, "input_json")) as Json,
    output: decodePayload(nullableText(row, "output_json")),
    error: decodeError(nullableText(row, "error_json")),
    createdAt: int(row, "created_at"),
    updatedAt: int(row, "updated_at"),
  };
}

function toJournal(row: Row): JournalRecord {
  return {
    invocationId: text(row, "invocation_id"),
    seq: int(row, "seq"),
    kind: text(row, "kind") as JournalKind,
    name: text(row, "name"),
    status: text(row, "status") as JournalStatus,
    attempt: int(row, "attempt"),
    availableAt: nullableInt(row, "available_at"),
    output: decodePayload(nullableText(row, "output_json")),
    error: decodeError(nullableText(row, "error_json")),
    startedAt: nullableInt(row, "started_at"),
    completedAt: nullableInt(row, "completed_at"),
  };
}

function toSchedule(row: Row): ScheduleRecord {
  return {
    id: text(row, "id"),
    workflowName: text(row, "workflow_name"),
    input: decodePayload(text(row, "input_json")) as Json,
    everyMs: int(row, "every_ms"),
    scheduleType: text(row, "schedule_type") as "interval" | "daily",
    dailyAt: nullableText(row, "daily_at"),
    timezone: nullableText(row, "timezone"),
    nextRunAt: int(row, "next_run_at"),
    catchUp: text(row, "catch_up") as CatchUpPolicy,
    maxCatchUp: int(row, "max_catch_up"),
    enabled: int(row, "enabled") === 1,
    lastScheduledAt: nullableInt(row, "last_scheduled_at"),
    createdAt: int(row, "created_at"),
    updatedAt: int(row, "updated_at"),
  };
}

export interface SqliteStoreOptions {
  /** `":memory:"` is supported for tests. */
  path: string;
  busyTimeoutMs?: number;
}

export class SqliteStore implements Store {
  readonly driver = "node:sqlite";
  readonly path: string;

  #db: DatabaseSync;
  #txDepth = 0;

  constructor(options: SqliteStoreOptions) {
    this.path = options.path === ":memory:"
      ? ":memory:"
      : resolve(options.path);

    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
    }

    this.#db = new DatabaseSync(this.path);
    if (this.path !== ":memory:") {
      this.#db.exec("PRAGMA journal_mode = WAL");
    }
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA synchronous = FULL");
    this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  }

  // ---------------------------------------------------------------- lifecycle

  migrate(): void {
    const current = this.schemaVersion();
    if (current > LATEST_SCHEMA_VERSION) {
      throw new MiniRestateError(
        `database schema version ${current} is newer than this build supports ` +
          `(${LATEST_SCHEMA_VERSION}); upgrade mini-restate`,
        { code: "SCHEMA_TOO_NEW", exitCode: 4 },
      );
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(migration.sql);
        this.#db.exec(`PRAGMA user_version = ${migration.version}`);
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw new MiniRestateError(
          `migration ${migration.version} (${migration.name}) failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { code: "MIGRATION_FAILED", cause: error },
        );
      }
    }
  }

  close(): void {
    this.#db.close();
  }

  schemaVersion(): number {
    const row = this.#db.prepare("PRAGMA user_version").get() as Row;
    return Number(row.user_version ?? 0);
  }

  integrityCheck(): string[] {
    const rows = this.#db.prepare("PRAGMA integrity_check").all() as Row[];
    return rows.map((row) => String(row.integrity_check));
  }

  transaction<T>(fn: () => T): T {
    if (this.#txDepth > 0) {
      this.#txDepth += 1;
      try {
        return fn();
      } finally {
        this.#txDepth -= 1;
      }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#txDepth = 1;
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // The transaction was already rolled back by SQLite.
      }
      throw error;
    } finally {
      this.#txDepth = 0;
    }
  }

  // -------------------------------------------------------------- invocations

  insertInvocation(record: InvocationRecord): void {
    this.#db
      .prepare(
        `INSERT INTO invocations (
           id, workflow_name, workflow_version, status, available_at,
           idempotency_key, schedule_id, scheduled_at, scheduled_from,
           input_json, output_json, error_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workflowName,
        record.workflowVersion,
        record.status,
        record.availableAt,
        record.idempotencyKey,
        record.scheduleId,
        record.scheduledAt,
        record.scheduledFrom,
        encodePayload(record.input, "invocation.input") ?? "null",
        encodePayload(record.output, "invocation.output"),
        record.error === null ? null : JSON.stringify(record.error),
        record.createdAt,
        record.updatedAt,
      );
  }

  getInvocation(id: string): InvocationRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM invocations WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toInvocation(row) : null;
  }

  getInvocationByIdempotencyKey(
    workflowName: string,
    idempotencyKey: string,
  ): InvocationRecord | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM invocations WHERE workflow_name = ? AND idempotency_key = ?",
      )
      .get(workflowName, idempotencyKey) as Row | undefined;
    return row ? toInvocation(row) : null;
  }

  listInvocations(filter: InvocationFilter): InvocationRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    if (filter.workflowName) {
      clauses.push("workflow_name = ?");
      params.push(filter.workflowName);
    }
    if (filter.scheduleId) {
      clauses.push("schedule_id = ?");
      params.push(filter.scheduleId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const order = filter.order === "asc" ? "ASC" : "DESC";
    params.push(filter.limit ?? 50, filter.offset ?? 0);

    const rows = this.#db
      .prepare(
        `SELECT * FROM invocations ${where}
         ORDER BY created_at ${order}, id ${order}
         LIMIT ? OFFSET ?`,
      )
      .all(...(params as never[])) as Row[];
    return rows.map(toInvocation);
  }

  countInvocationsByStatus(): Record<string, number> {
    const rows = this.#db
      .prepare("SELECT status, COUNT(*) AS count FROM invocations GROUP BY status")
      .all() as Row[];
    const counts: Record<string, number> = {};
    for (const row of rows) counts[text(row, "status")] = int(row, "count");
    return counts;
  }

  updateInvocation(id: string, patch: InvocationPatch): void {
    const assignments: string[] = ["updated_at = ?"];
    const params: unknown[] = [patch.updatedAt];

    if (patch.status !== undefined) {
      assignments.push("status = ?");
      params.push(patch.status);
    }
    if (patch.availableAt !== undefined) {
      assignments.push("available_at = ?");
      params.push(patch.availableAt);
    }
    if (patch.clearOutput) {
      assignments.push("output_json = NULL");
    } else if ("output" in patch) {
      assignments.push("output_json = ?");
      params.push(encodePayload(patch.output, "invocation.output"));
    }
    if (patch.error !== undefined) {
      assignments.push("error_json = ?");
      params.push(patch.error === null ? null : JSON.stringify(patch.error));
    }

    params.push(id);
    this.#db
      .prepare(`UPDATE invocations SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...(params as never[]));
  }

  claimInvocation(id: string, now: number): boolean {
    const result = this.#db
      .prepare(
        `UPDATE invocations
           SET status = 'running', updated_at = ?
         WHERE id = ? AND status = 'pending' AND available_at <= ?`,
      )
      .run(now, id, now);
    return Number(result.changes) === 1;
  }

  findRunnable(now: number, limit: number): InvocationRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM invocations
         WHERE status = 'pending' AND available_at <= ?
         ORDER BY available_at ASC, created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(now, limit) as Row[];
    return rows.map(toInvocation);
  }

  wakeDueInvocations(now: number): number {
    const result = this.#db
      .prepare(
        `UPDATE invocations
           SET status = 'pending', updated_at = ?
         WHERE status IN ('sleeping', 'retry_wait') AND available_at <= ?`,
      )
      .run(now, now);
    return Number(result.changes);
  }

  recoverOrphanedRunning(now: number): number {
    const result = this.#db
      .prepare(
        `UPDATE invocations
           SET status = 'pending', available_at = ?, updated_at = ?
         WHERE status = 'running'`,
      )
      .run(now, now);
    return Number(result.changes);
  }

  // ------------------------------------------------------------------ journal

  getJournalEntry(invocationId: string, seq: number): JournalRecord | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM journal_entries WHERE invocation_id = ? AND seq = ?",
      )
      .get(invocationId, seq) as Row | undefined;
    return row ? toJournal(row) : null;
  }

  listJournal(invocationId: string): JournalRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM journal_entries WHERE invocation_id = ? ORDER BY seq ASC",
      )
      .all(invocationId) as Row[];
    return rows.map(toJournal);
  }

  insertJournalEntry(record: JournalRecord): void {
    this.#db
      .prepare(
        `INSERT INTO journal_entries (
           invocation_id, seq, kind, name, status, attempt,
           available_at, output_json, error_json, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.invocationId,
        record.seq,
        record.kind,
        record.name,
        record.status,
        record.attempt,
        record.availableAt,
        encodePayload(record.output, `journal[${record.seq}].output`),
        record.error === null ? null : JSON.stringify(record.error),
        record.startedAt,
        record.completedAt,
      );
  }

  updateJournalEntry(
    invocationId: string,
    seq: number,
    patch: JournalPatch,
  ): void {
    const assignments: string[] = [];
    const params: unknown[] = [];

    if (patch.status !== undefined) {
      assignments.push("status = ?");
      params.push(patch.status);
    }
    if (patch.attempt !== undefined) {
      assignments.push("attempt = ?");
      params.push(patch.attempt);
    }
    if (patch.availableAt !== undefined) {
      assignments.push("available_at = ?");
      params.push(patch.availableAt);
    }
    if ("output" in patch) {
      assignments.push("output_json = ?");
      params.push(encodePayload(patch.output, `journal[${seq}].output`));
    }
    if (patch.error !== undefined) {
      assignments.push("error_json = ?");
      params.push(patch.error === null ? null : JSON.stringify(patch.error));
    }
    if (patch.startedAt !== undefined) {
      assignments.push("started_at = ?");
      params.push(patch.startedAt);
    }
    if (patch.completedAt !== undefined) {
      assignments.push("completed_at = ?");
      params.push(patch.completedAt);
    }
    if (assignments.length === 0) return;

    params.push(invocationId, seq);
    this.#db
      .prepare(
        `UPDATE journal_entries SET ${assignments.join(", ")}
         WHERE invocation_id = ? AND seq = ?`,
      )
      .run(...(params as never[]));
  }

  deleteIncompleteJournalEntries(invocationId: string): number {
    const result = this.#db
      .prepare(
        `DELETE FROM journal_entries
         WHERE invocation_id = ? AND status <> 'completed'`,
      )
      .run(invocationId);
    return Number(result.changes);
  }

  // ---------------------------------------------------------------- schedules

  insertSchedule(record: ScheduleRecord): void {
    this.#db
      .prepare(
        `INSERT INTO schedules (
           id, workflow_name, input_json, every_ms, schedule_type, daily_at, timezone, next_run_at,
           catch_up, max_catch_up, enabled, last_scheduled_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workflowName,
        encodePayload(record.input, "schedule.input") ?? "null",
        record.everyMs,
        record.scheduleType,
        record.dailyAt,
        record.timezone,
        record.nextRunAt,
        record.catchUp,
        record.maxCatchUp,
        record.enabled ? 1 : 0,
        record.lastScheduledAt,
        record.createdAt,
        record.updatedAt,
      );
  }

  getSchedule(id: string): ScheduleRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM schedules WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toSchedule(row) : null;
  }

  listSchedules(): ScheduleRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM schedules ORDER BY id ASC")
      .all() as Row[];
    return rows.map(toSchedule);
  }

  findDueSchedules(now: number): ScheduleRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM schedules
         WHERE enabled = 1 AND next_run_at <= ?
         ORDER BY next_run_at ASC, id ASC`,
      )
      .all(now) as Row[];
    return rows.map(toSchedule);
  }

  updateSchedule(id: string, patch: SchedulePatch): void {
    const assignments: string[] = ["updated_at = ?"];
    const params: unknown[] = [patch.updatedAt];

    if (patch.workflowName !== undefined) {
      assignments.push("workflow_name = ?");
      params.push(patch.workflowName);
    }
    if (patch.input !== undefined) {
      assignments.push("input_json = ?");
      params.push(encodePayload(patch.input, "schedule.input") ?? "null");
    }
    if (patch.everyMs !== undefined) {
      assignments.push("every_ms = ?");
      params.push(patch.everyMs);
    }
    if (patch.scheduleType !== undefined) {
      assignments.push("schedule_type = ?");
      params.push(patch.scheduleType);
    }
    if (patch.dailyAt !== undefined) {
      assignments.push("daily_at = ?");
      params.push(patch.dailyAt);
    }
    if (patch.timezone !== undefined) {
      assignments.push("timezone = ?");
      params.push(patch.timezone);
    }
    if (patch.nextRunAt !== undefined) {
      assignments.push("next_run_at = ?");
      params.push(patch.nextRunAt);
    }
    if (patch.catchUp !== undefined) {
      assignments.push("catch_up = ?");
      params.push(patch.catchUp);
    }
    if (patch.maxCatchUp !== undefined) {
      assignments.push("max_catch_up = ?");
      params.push(patch.maxCatchUp);
    }
    if (patch.enabled !== undefined) {
      assignments.push("enabled = ?");
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.lastScheduledAt !== undefined) {
      assignments.push("last_scheduled_at = ?");
      params.push(patch.lastScheduledAt);
    }

    params.push(id);
    this.#db
      .prepare(`UPDATE schedules SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...(params as never[]));
  }

  deleteSchedule(id: string): boolean {
    const result = this.#db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    return Number(result.changes) === 1;
  }

  // ------------------------------------------------------------------- leases

  acquireLease(
    name: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): LeaseRecord | null {
    return this.transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM runtime_leases WHERE name = ?")
        .get(name) as Row | undefined;

      if (row && int(row, "expires_at") > now && text(row, "owner_id") !== ownerId) {
        return null;
      }

      const expiresAt = now + ttlMs;
      this.#db
        .prepare(
          `INSERT INTO runtime_leases (name, owner_id, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET owner_id = excluded.owner_id,
                                           expires_at = excluded.expires_at`,
        )
        .run(name, ownerId, expiresAt);
      return { name, ownerId, expiresAt };
    });
  }

  renewLease(
    name: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): boolean {
    const result = this.#db
      .prepare(
        `UPDATE runtime_leases SET expires_at = ?
         WHERE name = ? AND owner_id = ?`,
      )
      .run(now + ttlMs, name, ownerId);
    return Number(result.changes) === 1;
  }

  releaseLease(name: string, ownerId: string): void {
    this.#db
      .prepare("DELETE FROM runtime_leases WHERE name = ? AND owner_id = ?")
      .run(name, ownerId);
  }

  getLease(name: string): LeaseRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM runtime_leases WHERE name = ?")
      .get(name) as Row | undefined;
    if (!row) return null;
    return {
      name: text(row, "name"),
      ownerId: text(row, "owner_id"),
      expiresAt: int(row, "expires_at"),
    };
  }
}
