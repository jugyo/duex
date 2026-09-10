import type {
  InvocationRecord,
  InvocationStatus,
  JournalRecord,
  JournalStatus,
  Json,
  LeaseRecord,
  ScheduleRecord,
  SerializedError,
} from "../core/types.ts";

/**
 * Storage driver boundary.
 *
 * `node:sqlite` is still marked as a release candidate upstream, so the runtime
 * core only ever talks to this interface (design doc D5).
 */

export interface InvocationPatch {
  status?: InvocationStatus;
  availableAt?: number;
  output?: Json | undefined;
  /** `true` clears `output_json`; used when re-queueing a failed invocation. */
  clearOutput?: boolean;
  error?: SerializedError | null;
  updatedAt: number;
}

export interface JournalPatch {
  status?: JournalStatus;
  attempt?: number;
  availableAt?: number | null;
  output?: Json | undefined;
  error?: SerializedError | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface SchedulePatch {
  workflowName?: string;
  input?: Json;
  everyMs?: number;
  scheduleType?: ScheduleRecord["scheduleType"];
  dailyAt?: string | null;
  timezone?: string | null;
  nextRunAt?: number;
  catchUp?: ScheduleRecord["catchUp"];
  maxCatchUp?: number;
  enabled?: boolean;
  lastScheduledAt?: number | null;
  updatedAt: number;
}

export interface InvocationFilter {
  status?: InvocationStatus | InvocationStatus[];
  workflowName?: string;
  scheduleId?: string;
  limit?: number;
  offset?: number;
  /** `"asc"` (oldest first) or `"desc"` (newest first, the default). */
  order?: "asc" | "desc";
}

export interface Store {
  readonly driver: string;

  migrate(): void;
  close(): void;
  /** Runs `fn` inside a single write transaction. Nesting participates. */
  transaction<T>(fn: () => T): T;
  schemaVersion(): number;
  integrityCheck(): string[];

  insertInvocation(record: InvocationRecord): void;
  getInvocation(id: string): InvocationRecord | null;
  getInvocationByIdempotencyKey(
    workflowName: string,
    idempotencyKey: string,
  ): InvocationRecord | null;
  listInvocations(filter: InvocationFilter): InvocationRecord[];
  countInvocationsByStatus(): Record<string, number>;
  updateInvocation(id: string, patch: InvocationPatch): void;
  /** Atomically move `pending` -> `running` when due. Returns false if lost. */
  claimInvocation(id: string, now: number): boolean;
  findRunnable(now: number, limit: number): InvocationRecord[];
  /** `sleeping`/`retry_wait` whose `available_at` has passed -> `pending`. */
  wakeDueInvocations(now: number): number;
  /** `running` rows left behind by a dead runner -> `pending`. */
  recoverOrphanedRunning(now: number): number;

  getJournalEntry(invocationId: string, seq: number): JournalRecord | null;
  listJournal(invocationId: string): JournalRecord[];
  insertJournalEntry(record: JournalRecord): void;
  updateJournalEntry(
    invocationId: string,
    seq: number,
    patch: JournalPatch,
  ): void;
  /** Drops every non-`completed` entry so a manual retry re-runs that step. */
  deleteIncompleteJournalEntries(invocationId: string): number;

  insertSchedule(record: ScheduleRecord): void;
  getSchedule(id: string): ScheduleRecord | null;
  listSchedules(): ScheduleRecord[];
  findDueSchedules(now: number): ScheduleRecord[];
  updateSchedule(id: string, patch: SchedulePatch): void;
  deleteSchedule(id: string): boolean;

  acquireLease(
    name: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): LeaseRecord | null;
  renewLease(
    name: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): boolean;
  releaseLease(name: string, ownerId: string): void;
  getLease(name: string): LeaseRecord | null;
}

/** Thrown when a UNIQUE constraint (idempotency key) rejects an insert. */
export function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/iu.test(message);
}
