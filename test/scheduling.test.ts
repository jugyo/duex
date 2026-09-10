import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defineWorkflow } from "../src/index.ts";
import { dailySlotAt, previousDailySlot, scheduleIdempotencyKey } from "../src/core/scheduler.ts";
import { createTestRuntime, T0, tempDbPath } from "./helpers.ts";
import type { WorkflowContext } from "../src/core/types.ts";

const HOUR = 3_600_000;

const noop = defineWorkflow({
  name: "scheduled",
  version: "1",
  async run(ctx: WorkflowContext, input: unknown) {
    return ctx.run("record", () => ({ input: (input ?? null) as never }));
  },
});

function harnessWithSchedule(
  t: { after: (fn: () => void) => void },
  options: {
    catchUp?: "latest" | "all" | "skip";
    maxCatchUp?: number;
    every?: number;
  } = {},
) {
  const harness = createTestRuntime({ workflows: [noop] });
  t.after(harness.close);
  const schedule = harness.runtime.createSchedule({
    id: "hourly",
    workflow: "scheduled",
    input: { location: "Hakata Bay" },
    every: options.every ?? HOUR,
    catchUp: options.catchUp ?? "latest",
    maxCatchUp: options.maxCatchUp,
    startAt: T0 + HOUR,
  });
  return { harness, schedule };
}

describe("schedule materialization", () => {
  it("runs every morning in the configured timezone across DST", async (t) => {
    const harness = createTestRuntime({ workflows: [noop] });
    t.after(harness.close);
    harness.setNow(Date.parse("2026-03-07T16:00:00.000Z"));
    const schedule = harness.runtime.createDailySchedule({
      id: "morning", workflow: "scheduled", dailyAt: "09:00", timezone: "America/New_York",
    });
    assert.equal(new Date(schedule.nextRunAt).toISOString(), "2026-03-08T13:00:00.000Z");

    harness.setNow(schedule.nextRunAt);
    const first = harness.runtime.materializeSchedules()[0];
    assert.equal(first.created.length, 1);
    assert.equal(new Date(first.nextRunAt).toISOString(), "2026-03-09T13:00:00.000Z");
    const invocation = harness.runtime.listInvocations({ scheduleId: "morning" })[0];
    assert.equal(new Date(invocation.scheduledFrom!).toISOString(), "2026-03-07T14:00:00.000Z");
    assert.equal(
      new Date(previousDailySlot(schedule.nextRunAt, "09:00", "America/New_York")).toISOString(),
      "2026-03-07T14:00:00.000Z",
    );
  });

  it("moves a nonexistent DST wall-clock time to the first valid minute", (t) => {
    const harness = createTestRuntime({ workflows: [noop] });
    t.after(harness.close);
    harness.setNow(Date.parse("2026-03-07T16:00:00.000Z"));
    const schedule = harness.runtime.createDailySchedule({
      id: "gap", workflow: "scheduled", dailyAt: "02:30", timezone: "America/New_York",
    });
    assert.equal(new Date(schedule.nextRunAt).toISOString(), "2026-03-08T07:00:00.000Z");
  });

  it("uses the earlier instant when a DST wall-clock time occurs twice", () => {
    const slot = dailySlotAt({ year: 2026, month: 11, day: 1 }, "01:30", "America/New_York");
    assert.equal(new Date(slot).toISOString(), "2026-11-01T05:30:00.000Z");
  });

  it("keeps only the latest daily slot after missing multiple days", (t) => {
    const harness = createTestRuntime({ workflows: [noop] });
    t.after(harness.close);
    harness.setNow(Date.parse("2026-03-07T16:00:00.000Z"));
    harness.runtime.createDailySchedule({
      id: "latest-daily", workflow: "scheduled", dailyAt: "09:00", timezone: "America/New_York",
    });
    harness.setNow(Date.parse("2026-03-10T13:00:00.000Z"));

    const result = harness.runtime.materializeSchedules()[0];
    assert.equal(result.created.length, 1);
    assert.equal(result.dropped, 2);
    assert.equal(new Date(result.created[0].scheduledAt).toISOString(), "2026-03-10T13:00:00.000Z");
  });

  it("creates one invocation per due slot and advances next_run_at", async (t) => {
    const { harness } = harnessWithSchedule(t);

    harness.setNow(T0 + HOUR);
    const tick = await harness.runtime.tick({ maxRuns: 10 });

    assert.equal(tick.materialized.length, 1);
    assert.equal(tick.materialized[0].created.length, 1);
    assert.equal(tick.runs.length, 1);
    assert.equal(tick.runs[0].outcome, "completed");

    const invocation = harness.runtime.listInvocations({})[0];
    assert.equal(invocation.scheduleId, "hourly");
    assert.equal(invocation.scheduledAt, T0 + HOUR);
    assert.equal(invocation.scheduledFrom, null);
    assert.equal(
      invocation.idempotencyKey,
      scheduleIdempotencyKey("hourly", T0 + HOUR),
    );
    assert.deepEqual(invocation.input, { location: "Hakata Bay" });
    assert.equal(harness.runtime.getSchedule("hourly").nextRunAt, T0 + 2 * HOUR);
  });

  it("does nothing before the schedule is due", async (t) => {
    const { harness } = harnessWithSchedule(t);
    harness.setNow(T0 + HOUR - 1);
    const tick = await harness.runtime.tick({ maxRuns: 10 });
    assert.equal(tick.materialized.length, 0);
    assert.equal(harness.runtime.listInvocations({}).length, 0);
  });

  it("is idempotent when the same slot is materialized twice", async (t) => {
    const { harness } = harnessWithSchedule(t);
    harness.setNow(T0 + HOUR);

    harness.runtime.materializeSchedules();
    // Rewind the schedule as a crash between insert and commit would leave it.
    harness.store.updateSchedule("hourly", {
      nextRunAt: T0 + HOUR,
      updatedAt: harness.now(),
    });
    harness.runtime.materializeSchedules();

    assert.equal(harness.runtime.listInvocations({}).length, 1);
  });

  it("does not duplicate a materialized slot after restart", (t) => {
    const path = tempDbPath(t);
    const scheduledAt = T0 + HOUR;
    let harness = createTestRuntime({ workflows: [noop], dbPath: path, now: T0 });
    harness.runtime.createSchedule({ id: "restart", workflow: "scheduled", every: HOUR });
    harness.setNow(scheduledAt);
    harness.runtime.materializeSchedules();
    harness.close();

    harness = createTestRuntime({ workflows: [noop], dbPath: path, now: scheduledAt });
    t.after(harness.close);
    assert.equal(harness.runtime.materializeSchedules().length, 0);
    assert.equal(harness.runtime.listInvocations({ scheduleId: "restart" }).length, 1);
  });

  it("latest collapses a backlog into a single invocation", async (t) => {
    const { harness } = harnessWithSchedule(t, { catchUp: "latest" });
    harness.setNow(T0 + 6 * HOUR);

    const [materialized] = harness.runtime.materializeSchedules();
    assert.equal(materialized.created.length, 1);
    assert.equal(materialized.dropped, 5);
    assert.equal(materialized.created[0].scheduledAt, T0 + 6 * HOUR);
    assert.equal(harness.runtime.getSchedule("hourly").nextRunAt, T0 + 7 * HOUR);
  });

  it("all replays the whole backlog", async (t) => {
    const { harness } = harnessWithSchedule(t, { catchUp: "all" });
    harness.setNow(T0 + 5 * HOUR);

    const [materialized] = harness.runtime.materializeSchedules();
    assert.equal(materialized.created.length, 5);
    assert.deepEqual(
      materialized.created.map((entry) => entry.scheduledAt),
      [1, 2, 3, 4, 5].map((index) => T0 + index * HOUR),
    );
  });

  it("all defers past maxCatchUp to the next tick", async (t) => {
    const { harness } = harnessWithSchedule(t, { catchUp: "all", maxCatchUp: 2 });
    harness.setNow(T0 + 5 * HOUR);

    const first = harness.runtime.materializeSchedules()[0];
    assert.equal(first.created.length, 2);
    assert.equal(first.deferred, 3);

    const second = harness.runtime.materializeSchedules()[0];
    assert.equal(second.created.length, 2);
    assert.equal(harness.runtime.listInvocations({ limit: 100 }).length, 4);

    const third = harness.runtime.materializeSchedules()[0];
    assert.equal(third.created.length, 1);
    assert.equal(harness.runtime.listInvocations({ limit: 100 }).length, 5);
    assert.equal(harness.runtime.materializeSchedules().length, 0);
  });

  it("skip only advances the clock", async (t) => {
    const { harness } = harnessWithSchedule(t, { catchUp: "skip" });
    harness.setNow(T0 + 5 * HOUR);

    const [materialized] = harness.runtime.materializeSchedules();
    assert.equal(materialized.created.length, 0);
    assert.equal(materialized.dropped, 5);
    assert.equal(harness.runtime.listInvocations({}).length, 0);
    assert.ok(harness.runtime.getSchedule("hourly").nextRunAt > harness.now());
  });

  it("skips disabled schedules and resumes when re-enabled", async (t) => {
    const { harness } = harnessWithSchedule(t);
    harness.runtime.setScheduleEnabled("hourly", false);
    harness.setNow(T0 + 2 * HOUR);

    assert.equal(harness.runtime.materializeSchedules().length, 0);

    harness.runtime.setScheduleEnabled("hourly", true);
    assert.equal(harness.runtime.materializeSchedules()[0].created.length, 1);
  });

  it("validates schedule definitions", async (t) => {
    const harness = createTestRuntime({ workflows: [noop] });
    t.after(harness.close);

    assert.throws(
      () => harness.runtime.createSchedule({ id: "bad id", workflow: "scheduled", every: "1h" }),
      /invalid schedule id/,
    );
    assert.throws(
      () => harness.runtime.createSchedule({ id: "x", workflow: "missing", every: "1h" }),
      /unknown workflow/,
    );
    assert.throws(
      () =>
        harness.runtime.createSchedule({
          id: "x",
          workflow: "scheduled",
          every: "1h",
          catchUp: "sometimes" as never,
        }),
      /invalid catch-up policy/,
    );

    harness.runtime.createSchedule({ id: "dup", workflow: "scheduled", every: "1h" });
    assert.throws(
      () => harness.runtime.createSchedule({ id: "dup", workflow: "scheduled", every: "1h" }),
      /already exists/,
    );
  });

  it("deletes schedules without touching their invocations", async (t) => {
    const { harness } = harnessWithSchedule(t);
    harness.setNow(T0 + HOUR);
    harness.runtime.materializeSchedules();

    harness.runtime.deleteSchedule("hourly");
    assert.equal(harness.runtime.listSchedules().length, 0);
    assert.equal(harness.runtime.listInvocations({}).length, 1);
    assert.throws(() => harness.runtime.getSchedule("hourly"), /not found/);
  });
});

describe("tick", () => {
  it("honours --max-runs and leaves the rest pending", async (t) => {
    const harness = createTestRuntime({ workflows: [noop] });
    t.after(harness.close);

    for (let index = 0; index < 5; index += 1) {
      await harness.runtime.invoke({ workflow: "scheduled", input: { index } });
    }

    const first = await harness.runtime.tick({ maxRuns: 2 });
    assert.equal(first.runs.length, 2);
    assert.equal(harness.runtime.listInvocations({ status: "pending" }).length, 3);

    const second = await harness.runtime.tick({ maxRuns: 10 });
    assert.equal(second.runs.length, 3);
    assert.equal(harness.runtime.listInvocations({ status: "completed" }).length, 5);
  });

  it("wakes due sleeping invocations", async (t) => {
    const sleeper = defineWorkflow({
      name: "sleeper",
      version: "1",
      async run(ctx: WorkflowContext) {
        await ctx.sleep("nap", "30m");
        return ctx.run("after", () => "awake");
      },
    });
    const harness = createTestRuntime({ workflows: [sleeper] });
    t.after(harness.close);

    const { invocation } = await harness.runtime.invoke({ workflow: "sleeper" });
    await harness.runtime.tick({ maxRuns: 5 });
    assert.equal(harness.runtime.getInvocation(invocation.id).status, "sleeping");

    harness.advance(30 * 60_000);
    const tick = await harness.runtime.tick({ maxRuns: 5 });
    assert.equal(tick.woken, 1);
    assert.equal(harness.runtime.getInvocation(invocation.id).output, "awake");
  });
});
