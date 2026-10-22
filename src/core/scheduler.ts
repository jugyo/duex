import { newInvocationId } from "./ids.ts";
import { silentLogger } from "./logger.ts";
import { isUniqueConstraintError } from "../storage/store.ts";
import type { Logger } from "./logger.ts";
import type { WorkflowRegistry } from "./registry.ts";
import type { Store } from "../storage/store.ts";
import type { ScheduleRecord } from "./types.ts";

export interface MaterializedSchedule {
  scheduleId: string;
  workflowName: string;
  created: { id: string; scheduledAt: number }[];
  /** Slots dropped by the catch-up policy (`latest` / `skip`). */
  dropped: number;
  /** Slots deferred to the next tick because `maxCatchUp` was reached. */
  deferred: number;
  nextRunAt: number;
}

export interface ScheduleMaterializerOptions {
  store: Store;
  registry: WorkflowRegistry;
  logger?: Logger;
  now?: () => number;
}

/** Deterministic idempotency key so a slot can never be enqueued twice. */
export function scheduleIdempotencyKey(
  scheduleId: string,
  scheduledAt: number,
): string {
  return `schedule:${scheduleId}:${scheduledAt}`;
}

/**
 * Turns due schedules into invocations.
 *
 * Creating the invocations and advancing `next_run_at` happen in one
 * transaction, so a crash mid-materialization rolls back and the next tick
 * simply tries again (design doc §18 crash matrix).
 */
export class ScheduleMaterializer {
  #store: Store;
  #registry: WorkflowRegistry;
  #logger: Logger;
  #now: () => number;

  constructor(options: ScheduleMaterializerOptions) {
    this.#store = options.store;
    this.#registry = options.registry;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
  }

  materializeDue(now: number = this.#now()): MaterializedSchedule[] {
    const results: MaterializedSchedule[] = [];
    for (const schedule of this.#store.findDueSchedules(now)) {
      const result = this.materializeOne(schedule, now);
      if (result) results.push(result);
    }
    return results;
  }

  materializeOne(
    schedule: ScheduleRecord,
    now: number = this.#now(),
  ): MaterializedSchedule | null {
    const workflow = this.#registry.get(schedule.workflowName);
    if (!workflow) {
      this.#logger.warn("schedule.unknown_workflow", {
        scheduleId: schedule.id,
        workflow: schedule.workflowName,
      });
      return null;
    }

    const slots = plannedSlots(schedule, now);
    if (slots.times.length === 0 && slots.nextRunAt === schedule.nextRunAt) {
      return null;
    }

    return this.#store.transaction(() => {
      const created: { id: string; scheduledAt: number }[] = [];
      for (const scheduledAt of slots.times) {
        const idempotencyKey = scheduleIdempotencyKey(schedule.id, scheduledAt);
        const existing = this.#store.getInvocationByIdempotencyKey(
          schedule.workflowName,
          idempotencyKey,
        );
        if (existing) continue;

        const id = newInvocationId(now);
        try {
          this.#store.insertInvocation({
            id,
            workflowName: schedule.workflowName,
            workflowVersion: workflow.version,
            status: "pending",
            availableAt: scheduledAt,
            idempotencyKey,
            lane: schedule.lane,
            scheduleId: schedule.id,
            scheduledAt,
            scheduledFrom: schedule.scheduleType === "daily"
              ? previousDailySlot(scheduledAt, schedule.dailyAt!, schedule.timezone!)
              : null,
            input: schedule.input,
            output: undefined,
            error: null,
            createdAt: now,
            updatedAt: now,
          });
        } catch (error) {
          if (isUniqueConstraintError(error)) continue;
          throw error;
        }
        created.push({ id, scheduledAt });
      }

      this.#store.updateSchedule(schedule.id, {
        nextRunAt: slots.nextRunAt,
        lastScheduledAt:
          created.length > 0
            ? created[created.length - 1].scheduledAt
            : schedule.lastScheduledAt,
        updatedAt: now,
      });

      const result: MaterializedSchedule = {
        scheduleId: schedule.id,
        workflowName: schedule.workflowName,
        created,
        dropped: slots.dropped,
        deferred: slots.deferred,
        nextRunAt: slots.nextRunAt,
      };
      this.#logger.info("schedule.materialized", {
        scheduleId: schedule.id,
        workflow: schedule.workflowName,
        created: created.length,
        dropped: slots.dropped,
        deferred: slots.deferred,
        nextRunAt: slots.nextRunAt,
      });
      return result;
    });
  }
}

export interface SlotPlan {
  times: number[];
  nextRunAt: number;
  dropped: number;
  deferred: number;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(value: number, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function compareLocal(left: LocalParts, right: LocalParts): number {
  return ["year", "month", "day", "hour", "minute"].reduce((result, key) =>
    result || left[key as keyof LocalParts] - right[key as keyof LocalParts], 0);
}

function addLocalDay(parts: Pick<LocalParts, "year" | "month" | "day">): Pick<LocalParts, "year" | "month" | "day"> {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function subtractLocalDay(parts: Pick<LocalParts, "year" | "month" | "day">): Pick<LocalParts, "year" | "month" | "day"> {
  const previous = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1));
  return { year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1, day: previous.getUTCDate() };
}

/** Resolves a wall-clock daily slot. Gaps move to the first valid minute; overlaps use the earlier instant. */
export function dailySlotAt(
  date: Pick<LocalParts, "year" | "month" | "day">,
  dailyAt: string,
  timezone: string,
): number {
  const [hour, minute] = dailyAt.split(":").map(Number);
  const wanted = { ...date, hour, minute };
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let firstAfter: number | null = null;
  for (let instant = guess - 18 * 3_600_000; instant <= guess + 18 * 3_600_000; instant += 60_000) {
    const actual = localParts(instant, timezone);
    const comparison = compareLocal(actual, wanted);
    if (comparison === 0) return instant;
    if (comparison > 0 && actual.year === date.year && actual.month === date.month && actual.day === date.day) {
      firstAfter ??= instant;
    }
  }
  if (firstAfter !== null) return firstAfter;
  throw new RangeError(`daily slot ${dailyAt} could not be resolved in ${timezone}`);
}

/** Returns the first daily wall-clock slot strictly after `after`. */
export function nextDailySlot(after: number, dailyAt: string, timezone: string): number {
  let date = localParts(after, timezone);
  for (let count = 0; count < 3; count += 1) {
    const slot = dailySlotAt(date, dailyAt, timezone);
    if (slot > after) return slot;
    date = { ...date, ...addLocalDay(date) };
  }
  throw new RangeError(`next daily slot could not be resolved in ${timezone}`);
}

/** Returns the daily wall-clock slot immediately before `before`. */
export function previousDailySlot(before: number, dailyAt: string, timezone: string): number {
  let date = localParts(before - 1, timezone);
  for (let count = 0; count < 3; count += 1) {
    const slot = dailySlotAt(date, dailyAt, timezone);
    if (slot < before) return slot;
    date = { ...date, ...subtractLocalDay(date) };
  }
  throw new RangeError(`previous daily slot could not be resolved in ${timezone}`);
}

function followingSlot(schedule: Pick<ScheduleRecord, "everyMs"> & Partial<Pick<ScheduleRecord, "scheduleType" | "dailyAt" | "timezone">>, slot: number): number {
  return schedule.scheduleType === "daily"
    ? nextDailySlot(slot, schedule.dailyAt!, schedule.timezone!)
    : slot + schedule.everyMs;
}

/**
 * Pure catch-up calculation (design doc §10).
 *
 * `latest` keeps only the newest missed slot, `skip` keeps none, and `all`
 * replays missed slots oldest-first, deferring anything beyond `maxCatchUp`
 * to the next tick instead of dropping it.
 */
export function plannedSlots(
  schedule: Pick<
    ScheduleRecord,
    "nextRunAt" | "everyMs" | "catchUp" | "maxCatchUp"
  > & Partial<Pick<ScheduleRecord, "scheduleType" | "dailyAt" | "timezone">>,
  now: number,
): SlotPlan {
  const { nextRunAt } = schedule;
  if (nextRunAt > now) {
    return { times: [], nextRunAt, dropped: 0, deferred: 0 };
  }

  if (schedule.scheduleType !== "daily") {
    const missed = Math.floor((now - nextRunAt) / schedule.everyMs) + 1;
    const latest = nextRunAt + (missed - 1) * schedule.everyMs;
    if (schedule.catchUp === "skip") {
      return { times: [], nextRunAt: latest + schedule.everyMs, dropped: missed, deferred: 0 };
    }
    if (schedule.catchUp === "all") {
      const take = Math.min(missed, Math.max(1, schedule.maxCatchUp));
      const times = Array.from({ length: take }, (_, index) => nextRunAt + index * schedule.everyMs);
      return {
        times,
        nextRunAt: times[times.length - 1] + schedule.everyMs,
        dropped: 0,
        deferred: missed - take,
      };
    }
    return {
      times: [latest],
      nextRunAt: latest + schedule.everyMs,
      dropped: missed - 1,
      deferred: 0,
    };
  }

  const due: number[] = [];
  let cursor = nextRunAt;
  while (cursor <= now) {
    due.push(cursor);
    cursor = followingSlot(schedule, cursor);
  }
  const missed = due.length;
  const latest = due[due.length - 1];

  if (schedule.catchUp === "skip") {
    return { times: [], nextRunAt: cursor, dropped: missed, deferred: 0 };
  }

  if (schedule.catchUp === "all") {
    const limit = Math.max(1, schedule.maxCatchUp);
    const take = Math.min(missed, limit);
    const times: number[] = [];
    for (let index = 0; index < take; index += 1) {
      times.push(due[index]);
    }
    return {
      times,
      nextRunAt: followingSlot(schedule, times[times.length - 1]),
      dropped: 0,
      deferred: missed - take,
    };
  }

  return {
    times: [latest],
    nextRunAt: cursor,
    dropped: missed - 1,
    deferred: 0,
  };
}
