import { setTimeout as delay } from "node:timers/promises";

import { parseDuration } from "./duration.ts";
import {
  ConfigError,
  ConflictError,
  NotFoundError,
  UsageError,
} from "./errors.ts";
import { newInvocationId, newOwnerId } from "./ids.ts";
import { assertJson } from "./json.ts";
import { RUNNER_LEASE, RunnerLease } from "./lease.ts";
import { silentLogger } from "./logger.ts";
import { InvocationRunner } from "./runner.ts";
import { nextDailySlot, ScheduleMaterializer } from "./scheduler.ts";
import { isUniqueConstraintError } from "../storage/store.ts";
import { TERMINAL_STATUSES } from "./types.ts";
import type { Logger } from "./logger.ts";
import type { WorkflowRegistry } from "./registry.ts";
import type { MaterializedSchedule } from "./scheduler.ts";
import type { InvocationFilter, Store } from "../storage/store.ts";
import type { InvocationResult, RunOutcome } from "./runner.ts";
import type {
  CatchUpPolicy,
  Duration,
  InvocationRecord,
  InvocationStatus,
  JournalRecord,
  Json,
  RetryPolicy,
  ScheduleRecord,
} from "./types.ts";

export interface RuntimeApiOptions {
  store: Store;
  registry: WorkflowRegistry;
  logger?: Logger;
  now?: () => number;
  ownerId?: string;
  leaseTtlMs?: number;
  defaultRetry?: RetryPolicy;
}

export interface InvokeRequest {
  workflow: string;
  input?: unknown;
  idempotencyKey?: string | null;
  /** Run the invocation inline until it completes, fails or suspends. */
  wait?: boolean;
  /** Upper bound for `wait`; a longer sleep/backoff returns early. */
  waitTimeoutMs?: number;
}

export interface InvokeResult {
  invocation: InvocationRecord;
  /** `false` when an existing invocation was returned for the same key. */
  created: boolean;
  ran: boolean;
  outcome?: RunOutcome;
}

export interface TickOptions {
  maxRuns?: number;
  /** Stop starting new invocations after this instant. */
  deadlineMs?: number;
  /** Materialize due schedules before running (default true). */
  schedules?: boolean;
}

export interface TickResult {
  ran: boolean;
  /** True when another runner holds the lease; the CLI exits 0. */
  skipped: boolean;
  reason?: string;
  owner?: string;
  materialized: MaterializedSchedule[];
  recovered: number;
  woken: number;
  runs: {
    id: string;
    workflow: string;
    outcome: RunOutcome;
    durationMs: number;
    reason?: string;
  }[];
}

export interface CreateScheduleRequest {
  id: string;
  workflow: string;
  input?: unknown;
  every: Duration;
  catchUp?: CatchUpPolicy;
  maxCatchUp?: number;
  startAt?: number;
  enabled?: boolean;
}

export interface CreateDailyScheduleRequest {
  id: string;
  workflow: string;
  input?: unknown;
  dailyAt: string;
  timezone: string;
  catchUp?: CatchUpPolicy;
  maxCatchUp?: number;
  startAt?: number;
  enabled?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  driver: string;
  schemaVersion: number;
  integrity: string[];
  registeredWorkflows: { name: string; version: string }[];
  invocationCounts: Record<string, number>;
  lease: { name: string; ownerId: string; expiresAt: number; stale: boolean } | null;
  problems: { kind: string; message: string; detail?: Json }[];
}

const CATCH_UP_POLICIES: CatchUpPolicy[] = ["latest", "all", "skip"];

const VALID_STATUSES: InvocationStatus[] = [
  "pending",
  "running",
  "sleeping",
  "retry_wait",
  "completed",
  "failed",
  "cancelled",
];

/**
 * The single use-case surface shared by every ingress adapter.
 *
 * CLI and HTTP are both first-class front doors; neither implements workflow
 * semantics, validation or status transitions of its own (design doc D2).
 */
export class RuntimeApi {
  readonly store: Store;
  readonly registry: WorkflowRegistry;
  readonly ownerId: string;

  #logger: Logger;
  #now: () => number;
  #leaseTtlMs: number;
  #runner: InvocationRunner;
  #materializer: ScheduleMaterializer;
  #lease: RunnerLease | null = null;

  constructor(options: RuntimeApiOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.ownerId = options.ownerId ?? newOwnerId();
    this.#leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.#runner = new InvocationRunner({
      store: this.store,
      registry: this.registry,
      logger: this.#logger,
      now: this.#now,
      defaultRetry: options.defaultRetry,
      onProgress: () => this.#lease?.renew(),
    });
    this.#materializer = new ScheduleMaterializer({
      store: this.store,
      registry: this.registry,
      logger: this.#logger,
      now: this.#now,
    });
  }

  // ----------------------------------------------------------------- lifecycle

  init(): { schemaVersion: number; driver: string } {
    this.store.migrate();
    return { schemaVersion: this.store.schemaVersion(), driver: this.store.driver };
  }

  close(): void {
    this.#lease?.release();
    this.store.close();
  }

  health(): { ok: boolean; driver: string; schemaVersion: number; now: number } {
    return {
      ok: true,
      driver: this.store.driver,
      schemaVersion: this.store.schemaVersion(),
      now: this.#now(),
    };
  }

  workflows(): { name: string; version: string }[] {
    return this.registry
      .list()
      .map((workflow) => ({ name: workflow.name, version: workflow.version }));
  }

  // ---------------------------------------------------------------- invoke

  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    const workflow = this.registry.get(request.workflow);
    if (!workflow) {
      throw new ConfigError(
        `unknown workflow ${JSON.stringify(request.workflow)}; registered: ${
          this.registry.names().join(", ") || "(none)"
        }`,
      );
    }

    const input = assertJson(request.input ?? null, "input");
    const idempotencyKey = request.idempotencyKey ?? null;
    if (idempotencyKey !== null && idempotencyKey.trim() === "") {
      throw new UsageError("idempotency key must not be empty");
    }

    const { invocation, created } = this.#enqueue(
      workflow.name,
      workflow.version,
      input,
      idempotencyKey,
    );

    if (!request.wait) {
      return { invocation, created, ran: false };
    }

    const timeoutMs = request.waitTimeoutMs ?? 60_000;
    const result = await this.withRunnerLease(async (acquired) => {
      if (!acquired) return null;
      return this.#driveToRest(invocation.id, this.#now() + timeoutMs);
    });

    if (result === null) {
      return {
        invocation: this.store.getInvocation(invocation.id)!,
        created,
        ran: false,
      };
    }
    return {
      invocation: result.invocation,
      created,
      ran: result.ran,
      outcome: result.outcome,
    };
  }

  #enqueue(
    workflowName: string,
    workflowVersion: string,
    input: Json,
    idempotencyKey: string | null,
  ): { invocation: InvocationRecord; created: boolean } {
    return this.store.transaction(() => {
      if (idempotencyKey !== null) {
        const existing = this.store.getInvocationByIdempotencyKey(
          workflowName,
          idempotencyKey,
        );
        if (existing) return { invocation: existing, created: false };
      }

      const now = this.#now();
      const record: InvocationRecord = {
        id: newInvocationId(now),
        workflowName,
        workflowVersion,
        status: "pending",
        availableAt: now,
        idempotencyKey,
        scheduleId: null,
        scheduledAt: null,
        scheduledFrom: null,
        input,
        output: undefined,
        error: null,
        createdAt: now,
        updatedAt: now,
      };

      try {
        this.store.insertInvocation(record);
      } catch (error) {
        if (idempotencyKey !== null && isUniqueConstraintError(error)) {
          const existing = this.store.getInvocationByIdempotencyKey(
            workflowName,
            idempotencyKey,
          );
          if (existing) return { invocation: existing, created: false };
        }
        throw error;
      }

      this.#logger.info("invocation.enqueued", {
        invocationId: record.id,
        workflow: workflowName,
        workflowVersion,
        idempotencyKey,
      });
      return { invocation: record, created: true };
    });
  }

  /** Run one invocation until it reaches a resting state (or the deadline). */
  async #driveToRest(
    id: string,
    deadline: number,
  ): Promise<{ invocation: InvocationRecord; ran: boolean; outcome?: RunOutcome }> {
    let ran = false;
    let outcome: RunOutcome | undefined;

    for (;;) {
      const current = this.store.getInvocation(id);
      if (!current) throw new NotFoundError(`invocation ${id} not found`);
      if (TERMINAL_STATUSES.includes(current.status) || current.status === "running") {
        return { invocation: current, ran, outcome };
      }

      const now = this.#now();
      if (current.availableAt > now) {
        if (current.availableAt > deadline) return { invocation: current, ran, outcome };
        await delay(current.availableAt - now);
      }
      this.store.wakeDueInvocations(this.#now());

      const refreshed = this.store.getInvocation(id)!;
      if (refreshed.status !== "pending") return { invocation: refreshed, ran, outcome };

      const result = await this.#runner.run(id);
      ran = ran || result.outcome !== "skipped";
      outcome = result.outcome;
      if (result.outcome === "skipped") return { invocation: result.invocation, ran, outcome };
    }
  }

  // ------------------------------------------------------------------ queries

  getInvocation(id: string): InvocationRecord {
    const invocation = this.store.getInvocation(id);
    if (!invocation) throw new NotFoundError(`invocation ${id} not found`);
    return invocation;
  }

  listInvocations(filter: InvocationFilter = {}): InvocationRecord[] {
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      for (const status of statuses) {
        if (!VALID_STATUSES.includes(status)) {
          throw new UsageError(
            `invalid status ${JSON.stringify(status)}; expected one of ${VALID_STATUSES.join(", ")}`,
          );
        }
      }
    }
    return this.store.listInvocations(filter);
  }

  getJournal(id: string): JournalRecord[] {
    this.getInvocation(id);
    return this.store.listJournal(id);
  }

  // --------------------------------------------------------------- operations

  retryInvocation(id: string): InvocationRecord {
    return this.store.transaction(() => {
      const invocation = this.getInvocation(id);
      if (invocation.status !== "failed") {
        throw new ConflictError(
          `invocation ${id} is ${invocation.status}; only failed invocations can be retried`,
        );
      }
      const now = this.#now();
      const removed = this.store.deleteIncompleteJournalEntries(id);
      this.store.updateInvocation(id, {
        status: "pending",
        availableAt: now,
        error: null,
        clearOutput: true,
        updatedAt: now,
      });
      this.#logger.info("invocation.retry_requested", {
        invocationId: id,
        clearedJournalEntries: removed,
      });
      return this.store.getInvocation(id)!;
    });
  }

  cancelInvocation(id: string): InvocationRecord {
    return this.store.transaction(() => {
      const invocation = this.getInvocation(id);
      if (TERMINAL_STATUSES.includes(invocation.status)) {
        throw new ConflictError(
          `invocation ${id} is already ${invocation.status}`,
        );
      }
      if (invocation.status === "running") {
        throw new ConflictError(
          `invocation ${id} is running; cancellation is cooperative and only ` +
            `applies at operation boundaries — retry once it suspends`,
        );
      }
      const now = this.#now();
      this.store.updateInvocation(id, {
        status: "cancelled",
        availableAt: now,
        updatedAt: now,
      });
      this.#logger.info("invocation.cancelled", { invocationId: id });
      return this.store.getInvocation(id)!;
    });
  }

  // --------------------------------------------------------------------- tick

  async tick(options: TickOptions = {}): Promise<TickResult> {
    const maxRuns = options.maxRuns ?? 20;
    if (maxRuns < 0) throw new UsageError("--max-runs must be >= 0");

    const result = await this.withRunnerLease(async (acquired) => {
      if (!acquired) {
        const lease = this.store.getLease(RUNNER_LEASE);
        return {
          ran: false,
          skipped: true,
          reason: "another runner holds the lease",
          owner: lease?.ownerId,
          materialized: [],
          recovered: 0,
          woken: 0,
          runs: [],
        } satisfies TickResult;
      }

      // A live lease could not be acquired above unless the previous holder's
      // lease expired, so any `running` row is an orphan from a dead runner.
      const recovered = this.store.recoverOrphanedRunning(this.#now());
      const materialized =
        options.schedules === false
          ? []
          : this.#materializer.materializeDue(this.#now());
      let woken = this.store.wakeDueInvocations(this.#now());

      const runs: TickResult["runs"] = [];
      while (runs.length < maxRuns) {
        if (options.deadlineMs !== undefined && this.#now() >= options.deadlineMs) break;
        if (this.#lease && !this.#lease.renew()) {
          // Another runner took over; stop before starting more work.
          this.#logger.warn("tick.lease_lost", { owner: this.ownerId });
          break;
        }

        const [next] = this.store.findRunnable(this.#now(), 1);
        if (!next) {
          woken += this.store.wakeDueInvocations(this.#now());
          const [retryNext] = this.store.findRunnable(this.#now(), 1);
          if (!retryNext) break;
          runs.push(this.#summarize(await this.#runner.run(retryNext.id)));
          continue;
        }
        runs.push(this.#summarize(await this.#runner.run(next.id)));
      }

      return {
        ran: true,
        skipped: false,
        materialized,
        recovered,
        woken,
        runs,
      } satisfies TickResult;
    });

    this.#logger.info("tick.finished", {
      skipped: result.skipped,
      recovered: result.recovered,
      woken: result.woken,
      materialized: result.materialized.length,
      runs: result.runs.length,
    });
    return result;
  }

  #summarize(result: InvocationResult): TickResult["runs"][number] {
    const summary: TickResult["runs"][number] = {
      id: result.id,
      workflow: result.invocation.workflowName,
      outcome: result.outcome,
      durationMs: result.durationMs,
    };
    if (result.reason) summary.reason = result.reason;
    return summary;
  }

  /**
   * Run `fn` while holding the single runner lease. `fn` receives `false` when
   * another live runner owns it, so callers can exit cleanly.
   */
  async withRunnerLease<T>(fn: (acquired: boolean) => Promise<T>): Promise<T> {
    if (this.#lease && !this.#lease.released) return fn(true);

    const lease = RunnerLease.acquire({
      store: this.store,
      ownerId: this.ownerId,
      ttlMs: this.#leaseTtlMs,
      now: this.#now,
      logger: this.#logger,
    });
    if (!lease) return fn(false);

    this.#lease = lease;
    lease.startHeartbeat();
    try {
      return await fn(true);
    } finally {
      lease.release();
      this.#lease = null;
    }
  }

  // ---------------------------------------------------------------- schedules

  createSchedule(request: CreateScheduleRequest): ScheduleRecord {
    if (!request.id || !/^[\w.:-]+$/u.test(request.id)) {
      throw new UsageError(
        `invalid schedule id ${JSON.stringify(request.id)}; use letters, digits, "-", "_", "." or ":"`,
      );
    }
    const workflow = this.registry.get(request.workflow);
    if (!workflow) {
      throw new ConfigError(`unknown workflow ${JSON.stringify(request.workflow)}`);
    }
    const everyMs = parseDuration(request.every);
    if (everyMs <= 0) throw new UsageError("--every must be greater than zero");

    const catchUp = request.catchUp ?? "latest";
    if (!CATCH_UP_POLICIES.includes(catchUp)) {
      throw new UsageError(
        `invalid catch-up policy ${JSON.stringify(catchUp)}; expected ${CATCH_UP_POLICIES.join(", ")}`,
      );
    }

    const now = this.#now();
    const record: ScheduleRecord = {
      id: request.id,
      workflowName: workflow.name,
      input: assertJson(request.input ?? null, "schedule.input"),
      everyMs,
      scheduleType: "interval",
      dailyAt: null,
      timezone: null,
      nextRunAt: request.startAt ?? now + everyMs,
      catchUp,
      maxCatchUp: request.maxCatchUp ?? 100,
      enabled: request.enabled ?? true,
      lastScheduledAt: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      this.store.insertSchedule(record);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictError(`schedule ${request.id} already exists`);
      }
      throw error;
    }
    this.#logger.info("schedule.created", {
      scheduleId: record.id,
      workflow: record.workflowName,
      everyMs,
      nextRunAt: record.nextRunAt,
    });
    return record;
  }

  createDailySchedule(request: CreateDailyScheduleRequest): ScheduleRecord {
    if (!request.id || !/^[\w.:-]+$/u.test(request.id)) {
      throw new UsageError(
        `invalid schedule id ${JSON.stringify(request.id)}; use letters, digits, "-", "_", "." or ":"`,
      );
    }
    const workflow = this.registry.get(request.workflow);
    if (!workflow) {
      throw new ConfigError(`unknown workflow ${JSON.stringify(request.workflow)}`);
    }
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(request.dailyAt)) {
      throw new UsageError("dailyAt must be HH:MM");
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: request.timezone }).format(0);
    } catch {
      throw new UsageError(`invalid timezone ${JSON.stringify(request.timezone)}`);
    }
    const catchUp = request.catchUp ?? "latest";
    if (!CATCH_UP_POLICIES.includes(catchUp)) {
      throw new UsageError(`invalid catch-up policy ${JSON.stringify(catchUp)}`);
    }
    const now = this.#now();
    const record: ScheduleRecord = {
      id: request.id,
      workflowName: workflow.name,
      input: assertJson(request.input ?? null, "schedule.input"),
      everyMs: 86_400_000,
      scheduleType: "daily",
      dailyAt: request.dailyAt,
      timezone: request.timezone,
      nextRunAt: request.startAt ?? nextDailySlot(now, request.dailyAt, request.timezone),
      catchUp,
      maxCatchUp: request.maxCatchUp ?? 100,
      enabled: request.enabled ?? true,
      lastScheduledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.store.insertSchedule(record);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictError(`schedule ${request.id} already exists`);
      }
      throw error;
    }
    return record;
  }

  listSchedules(): ScheduleRecord[] {
    return this.store.listSchedules();
  }

  getSchedule(id: string): ScheduleRecord {
    const schedule = this.store.getSchedule(id);
    if (!schedule) throw new NotFoundError(`schedule ${id} not found`);
    return schedule;
  }

  setScheduleEnabled(id: string, enabled: boolean): ScheduleRecord {
    this.getSchedule(id);
    this.store.updateSchedule(id, { enabled, updatedAt: this.#now() });
    return this.store.getSchedule(id)!;
  }

  deleteSchedule(id: string): void {
    if (!this.store.deleteSchedule(id)) {
      throw new NotFoundError(`schedule ${id} not found`);
    }
    this.#logger.info("schedule.deleted", { scheduleId: id });
  }

  /** Materialize due schedules without running anything. */
  materializeSchedules(): MaterializedSchedule[] {
    return this.#materializer.materializeDue(this.#now());
  }

  // ------------------------------------------------------- diagnostics/export

  doctor(): DoctorReport {
    const integrity = this.store.integrityCheck();
    const problems: DoctorReport["problems"] = [];

    for (const line of integrity) {
      if (line !== "ok") {
        problems.push({ kind: "integrity", message: line });
      }
    }

    const leaseRecord = this.store.getLease(RUNNER_LEASE);
    const now = this.#now();
    const lease = leaseRecord
      ? { ...leaseRecord, stale: leaseRecord.expiresAt <= now }
      : null;
    if (lease?.stale) {
      problems.push({
        kind: "stale_lease",
        message: `runner lease held by ${lease.ownerId} expired at ${lease.expiresAt}`,
      });
    }

    const active = this.store.listInvocations({
      status: ["pending", "running", "sleeping", "retry_wait"],
      limit: 1000,
    });
    for (const invocation of active) {
      const workflow = this.registry.get(invocation.workflowName);
      if (!workflow) {
        problems.push({
          kind: "unknown_workflow",
          message: `invocation ${invocation.id} references unregistered workflow ${invocation.workflowName}`,
        });
      } else if (workflow.version !== invocation.workflowVersion) {
        problems.push({
          kind: "version_mismatch",
          message:
            `invocation ${invocation.id} is pinned to ${invocation.workflowName}@` +
            `${invocation.workflowVersion} but ${workflow.version} is registered`,
        });
      }
    }

    return {
      ok: problems.length === 0,
      driver: this.store.driver,
      schemaVersion: this.store.schemaVersion(),
      integrity,
      registeredWorkflows: this.workflows(),
      invocationCounts: this.store.countInvocationsByStatus(),
      lease,
      problems,
    };
  }

  exportInvocations(options: { id?: string; limit?: number } = {}): {
    exportedAt: number;
    invocations: (InvocationRecord & { journal: JournalRecord[] })[];
  } {
    const invocations = options.id
      ? [this.getInvocation(options.id)]
      : this.store.listInvocations({ limit: options.limit ?? 500 });
    return {
      exportedAt: this.#now(),
      invocations: invocations.map((invocation) => ({
        ...invocation,
        journal: this.store.listJournal(invocation.id),
      })),
    };
  }
}
