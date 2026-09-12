/**
 * Shared types for the duex runtime core.
 *
 * Everything crossing the durability boundary (workflow input, step output,
 * error detail) must be representable as `Json`.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/** A duration in milliseconds, or a human string such as `"1h30m"`, `"250ms"`. */
export type Duration = number | string;

export type InvocationStatus =
  | "pending"
  | "running"
  | "sleeping"
  | "retry_wait"
  | "completed"
  | "failed"
  | "cancelled";

/** Statuses a runner is allowed to pick up (once `available_at` is due). */
export const RUNNABLE_STATUSES: InvocationStatus[] = ["pending"];

/** Statuses that become runnable again once their `available_at` is reached. */
export const WAKEABLE_STATUSES: InvocationStatus[] = ["sleeping", "retry_wait"];

export const TERMINAL_STATUSES: InvocationStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export type JournalKind = "run" | "sleep" | "now" | "uuid";

export type JournalStatus =
  | "running"
  | "sleeping"
  | "retry_wait"
  | "completed"
  | "failed";

export type CatchUpPolicy = "latest" | "all" | "skip";

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  factor?: number;
  maxDelayMs?: number;
}

export interface RunOptions {
  retry?: RetryPolicy;
}

export interface WorkflowContext {
  readonly invocationId: string;
  readonly workflowName: string;
  /** Persisted schedule slot for scheduled invocations; null for direct invokes. */
  readonly scheduledAt: Date | null;
  /** Persisted start of the schedule window; null when the schedule has no calendar window. */
  readonly scheduledFrom: Date | null;

  /** Execute `operation` at most once per invocation; the result is journaled. */
  run<T>(
    name: string,
    operation: () => Promise<T> | T,
    options?: RunOptions,
  ): Promise<T>;

  /** Durable sleep. Survives process restarts; the timer lives in SQLite. */
  sleep(name: string, duration: Duration): Promise<void>;

  /** Journaled wall clock. Replays return the originally recorded instant. */
  now(name: string): Promise<Date>;

  /** Journaled UUID v4. Replays return the originally recorded value. */
  uuid(name: string): Promise<string>;
}

export interface WorkflowDefinition<Input = any, Output = any> {
  readonly name: string;
  readonly version: string;
  run(ctx: WorkflowContext, input: Input): Promise<Output> | Output;
}

export function defineWorkflow<Input = any, Output = any>(
  definition: WorkflowDefinition<Input, Output>,
): WorkflowDefinition<Input, Output> {
  if (!definition.name || typeof definition.name !== "string") {
    throw new TypeError("defineWorkflow: `name` is required");
  }
  if (!definition.version || typeof definition.version !== "string") {
    throw new TypeError("defineWorkflow: `version` is required");
  }
  if (typeof definition.run !== "function") {
    throw new TypeError("defineWorkflow: `run` must be a function");
  }
  return definition;
}

/** Serialized shape of a thrown error, stored in `error_json`. */
export interface SerializedError {
  name: string;
  message: string;
  terminal: boolean;
  code?: string;
  stack?: string;
  detail?: Json;
}

export interface InvocationRecord {
  id: string;
  workflowName: string;
  workflowVersion: string;
  status: InvocationStatus;
  availableAt: number;
  idempotencyKey: string | null;
  scheduleId: string | null;
  scheduledAt: number | null;
  scheduledFrom: number | null;
  input: Json;
  /** `undefined` means the workflow returned void; `null` means it returned `null`. */
  output: Json | undefined;
  error: SerializedError | null;
  createdAt: number;
  updatedAt: number;
}

export interface JournalRecord {
  invocationId: string;
  seq: number;
  kind: JournalKind;
  name: string;
  status: JournalStatus;
  attempt: number;
  availableAt: number | null;
  output: Json | undefined;
  error: SerializedError | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface ScheduleRecord {
  id: string;
  workflowName: string;
  input: Json;
  everyMs: number;
  scheduleType: "interval" | "daily";
  dailyAt: string | null;
  timezone: string | null;
  nextRunAt: number;
  catchUp: CatchUpPolicy;
  maxCatchUp: number;
  enabled: boolean;
  lastScheduledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface LeaseRecord {
  name: string;
  ownerId: string;
  expiresAt: number;
}
