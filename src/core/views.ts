import { summarizePayload } from "./json.ts";
import type {
  InvocationRecord,
  JournalRecord,
  Json,
  ScheduleRecord,
} from "./types.ts";

/**
 * Wire shapes shared by every adapter.
 *
 * CLI `--json` and the HTTP API return byte-identical objects for the same
 * record, which is what the parity test asserts.
 */

export interface InvocationView {
  id: string;
  workflow: string;
  workflowVersion: string;
  status: string;
  availableAt: string;
  idempotencyKey: string | null;
  scheduleId: string | null;
  scheduledAt: string | null;
  scheduledFrom: string | null;
  input: Json;
  output: Json | null;
  hasOutput: boolean;
  error: Json | null;
  createdAt: string;
  updatedAt: string;
}

export interface JournalView {
  seq: number;
  kind: string;
  name: string;
  status: string;
  attempt: number;
  availableAt: string | null;
  output: Json | null;
  hasOutput: boolean;
  error: Json | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface ScheduleView {
  id: string;
  workflow: string;
  input: Json;
  everyMs: number;
  scheduleType: string;
  dailyAt: string | null;
  timezone: string | null;
  nextRunAt: string;
  catchUp: string;
  maxCatchUp: number;
  enabled: boolean;
  lastScheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function invocationView(record: InvocationRecord): InvocationView {
  return {
    id: record.id,
    workflow: record.workflowName,
    workflowVersion: record.workflowVersion,
    status: record.status,
    availableAt: iso(record.availableAt)!,
    idempotencyKey: record.idempotencyKey,
    scheduleId: record.scheduleId,
    scheduledAt: iso(record.scheduledAt),
    scheduledFrom: iso(record.scheduledFrom),
    input: record.input,
    output: record.output === undefined ? null : record.output,
    hasOutput: record.output !== undefined,
    error: (record.error as unknown as Json) ?? null,
    createdAt: iso(record.createdAt)!,
    updatedAt: iso(record.updatedAt)!,
  };
}

export function journalView(record: JournalRecord): JournalView {
  return {
    seq: record.seq,
    kind: record.kind,
    name: record.name,
    status: record.status,
    attempt: record.attempt,
    availableAt: iso(record.availableAt),
    output: record.output === undefined ? null : record.output,
    hasOutput: record.output !== undefined,
    error: (record.error as unknown as Json) ?? null,
    startedAt: iso(record.startedAt),
    completedAt: iso(record.completedAt),
    durationMs:
      record.startedAt !== null && record.completedAt !== null
        ? record.completedAt - record.startedAt
        : null,
  };
}

export function scheduleView(record: ScheduleRecord): ScheduleView {
  return {
    id: record.id,
    workflow: record.workflowName,
    input: record.input,
    everyMs: record.everyMs,
    scheduleType: record.scheduleType,
    dailyAt: record.dailyAt,
    timezone: record.timezone,
    nextRunAt: iso(record.nextRunAt)!,
    catchUp: record.catchUp,
    maxCatchUp: record.maxCatchUp,
    enabled: record.enabled,
    lastScheduledAt: iso(record.lastScheduledAt),
    createdAt: iso(record.createdAt)!,
    updatedAt: iso(record.updatedAt)!,
  };
}

/** Compact, log-safe journal line used by `journal show` and observability. */
export function journalSummary(record: JournalRecord, outputJson: string | null) {
  return {
    seq: record.seq,
    kind: record.kind,
    name: record.name,
    status: record.status,
    attempt: record.attempt,
    payload: summarizePayload(outputJson),
  };
}
