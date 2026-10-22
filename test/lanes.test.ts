import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { defineWorkflow, TerminalError } from "../src/index.ts";
import { createTestRuntime, T0 } from "./helpers.ts";
import type { InvocationRecord, WorkflowContext } from "../src/core/types.ts";

interface Overlap {
  /** Highest number of invocations that were inside their step at once. */
  maxActive: number;
  /** Lanes that had two invocations inside their step at the same time. */
  collisions: string[];
}

/**
 * A workflow whose step stays active across a real timer, so a tick that
 * starts two invocations has them overlap observably.
 */
function gatedWorkflow(overlap: Overlap) {
  const activeLanes = new Set<string>();
  let active = 0;

  return defineWorkflow({
    name: "gated",
    version: "1",
    async run(ctx: WorkflowContext, input: { lane: string | null; fail?: boolean }) {
      return ctx.run("work", async () => {
        active += 1;
        overlap.maxActive = Math.max(overlap.maxActive, active);
        if (input.lane !== null) {
          if (activeLanes.has(input.lane)) overlap.collisions.push(input.lane);
          activeLanes.add(input.lane);
        }
        try {
          await delay(10);
          if (input.fail) throw new TerminalError("step failed on purpose");
          return input.lane;
        } finally {
          active -= 1;
          if (input.lane !== null) activeLanes.delete(input.lane);
        }
      });
    },
  });
}

function createHarness(t: { after: (fn: () => void) => void }) {
  const overlap: Overlap = { maxActive: 0, collisions: [] };
  const harness = createTestRuntime({ workflows: [gatedWorkflow(overlap)] });
  t.after(harness.close);

  const enqueue = async (lane: string | null, options: { fail?: boolean } = {}) => {
    const result = await harness.runtime.invoke({
      workflow: "gated",
      input: { lane, ...(options.fail ? { fail: true } : {}) },
      lane,
    });
    return result.invocation;
  };

  return { harness, overlap, enqueue };
}

describe("invocation lanes", () => {
  it("stores the lane and exposes it unchanged", async (t) => {
    const { harness, enqueue } = createHarness(t);

    const laned = await enqueue("source:slack");
    const free = await enqueue(null);

    assert.equal(laned.lane, "source:slack");
    assert.equal(harness.runtime.getInvocation(laned.id).lane, "source:slack");
    assert.equal(free.lane, null);
    await assert.rejects(
      harness.runtime.invoke({ workflow: "gated", input: { lane: null }, lane: "  " }),
      /lane must not be empty/,
    );
  });

  it("hides a lane that already has a running invocation", async (t) => {
    const { harness, enqueue } = createHarness(t);

    const running = await enqueue("source:slack");
    const queued = await enqueue("source:slack");
    const other = await enqueue("source:github");
    const free = await enqueue(null);
    assert.ok(harness.store.claimInvocation(running.id, harness.now()));

    // Same-millisecond rows tie-break on id, so compare the set, not the order.
    const runnable = harness.store.findRunnable(harness.now(), 10).map((r) => r.id);
    assert.deepEqual(runnable.toSorted(), [other.id, free.id].toSorted());
    assert.ok(!runnable.includes(queued.id), "the busy lane must stay hidden");
  });

  it("runs lanes in parallel and keeps each lane serial", async (t) => {
    const { harness, overlap, enqueue } = createHarness(t);

    const created: InvocationRecord[] = [];
    for (const lane of ["source:slack", "source:slack", "source:github", "source:github"]) {
      created.push(await enqueue(lane));
    }

    const result = await harness.runtime.tick({ concurrency: 4 });

    assert.equal(result.runs.length, 4);
    assert.deepEqual(overlap.collisions, []);
    assert.equal(overlap.maxActive, 2, "one invocation per lane, both lanes at once");
    for (const invocation of created) {
      assert.equal(harness.runtime.getInvocation(invocation.id).status, "completed");
    }
  });

  it("runs invocations without a lane in parallel", async (t) => {
    const { harness, overlap, enqueue } = createHarness(t);
    for (let index = 0; index < 3; index += 1) await enqueue(null);

    const result = await harness.runtime.tick({ concurrency: 3 });

    assert.equal(result.runs.length, 3);
    assert.equal(overlap.maxActive, 3);
  });

  it("stays serial and in order by default", async (t) => {
    const { harness, overlap, enqueue } = createHarness(t);
    const ids = [
      (await enqueue("source:slack")).id,
      (await enqueue(null)).id,
      (await enqueue("source:github")).id,
    ];

    const result = await harness.runtime.tick();

    assert.equal(overlap.maxActive, 1);
    assert.deepEqual(result.runs.map((run) => run.id).toSorted(), ids.toSorted());
  });

  it("lets the other in-flight invocations finish when one fails", async (t) => {
    const { harness, enqueue } = createHarness(t);
    const failing = await enqueue("source:slack", { fail: true });
    const healthy = await enqueue("source:github");

    const result = await harness.runtime.tick({ concurrency: 2 });

    assert.equal(result.runs.length, 2);
    assert.equal(harness.runtime.getInvocation(failing.id).status, "failed");
    assert.equal(harness.runtime.getInvocation(healthy.id).status, "completed");
  });

  it("leaves an inline wait pending while its lane is running", async (t) => {
    const { harness, overlap, enqueue } = createHarness(t);
    const running = await enqueue("source:slack");
    assert.ok(harness.store.claimInvocation(running.id, harness.now()));

    const result = await harness.runtime.invoke({
      workflow: "gated",
      input: { lane: "source:slack" },
      lane: "source:slack",
      wait: true,
    });

    assert.equal(result.ran, false);
    assert.equal(result.invocation.status, "pending");
    assert.equal(overlap.maxActive, 0, "the busy lane must not run inline");
  });

  it("runs an inline wait once its lane is free", async (t) => {
    const { harness } = createHarness(t);

    const result = await harness.runtime.invoke({
      workflow: "gated",
      input: { lane: "source:slack" },
      lane: "source:slack",
      wait: true,
    });

    assert.equal(result.ran, true);
    assert.equal(result.invocation.status, "completed");
  });

  it("counts maxRuns as runs started and checks the deadline before starting", async (t) => {
    const { harness, enqueue } = createHarness(t);
    for (const lane of ["a", "b", "c", "d"]) await enqueue(lane);

    const capped = await harness.runtime.tick({ concurrency: 4, maxRuns: 2 });
    assert.equal(capped.runs.length, 2);

    const expired = await harness.runtime.tick({ concurrency: 4, deadlineMs: T0 });
    assert.equal(expired.runs.length, 0);

    for (const concurrency of [0, 1.5, Number.NaN]) {
      await assert.rejects(
        harness.runtime.tick({ concurrency }),
        /--concurrency must be an integer >= 1/,
      );
    }
  });
});

describe("schedule lanes", () => {
  const MINUTE = 60_000;

  function scheduleHarness(
    t: { after: (fn: () => void) => void },
    lane: string | null,
  ) {
    const { harness, overlap } = createHarness(t);
    const schedule = harness.runtime.createSchedule({
      id: "poll-slack",
      workflow: "gated",
      input: { lane },
      lane,
      every: MINUTE,
      catchUp: "all",
      startAt: T0 + MINUTE,
    });
    return { harness, overlap, schedule };
  }

  it("stores the lane and hands it to every materialized invocation", async (t) => {
    const { harness, schedule } = scheduleHarness(t, "source:slack");
    assert.equal(schedule.lane, "source:slack");
    assert.equal(harness.runtime.getSchedule("poll-slack").lane, "source:slack");

    harness.advance(2 * MINUTE);
    const [materialized] = harness.runtime.materializeSchedules();

    assert.equal(materialized.created.length, 2);
    for (const { id } of materialized.created) {
      assert.equal(harness.runtime.getInvocation(id).lane, "source:slack");
    }
  });

  it("keeps slots of one schedule serial even at a higher concurrency", async (t) => {
    const { harness, overlap } = scheduleHarness(t, "source:slack");
    harness.advance(2 * MINUTE);

    const result = await harness.runtime.tick({ concurrency: 4 });

    assert.equal(result.runs.length, 2);
    assert.deepEqual(overlap.collisions, []);
    assert.equal(overlap.maxActive, 1, "the next slot must wait for the running one");
  });

  it("leaves a schedule without a lane unconstrained", async (t) => {
    const { harness, overlap } = scheduleHarness(t, null);
    harness.advance(2 * MINUTE);

    const result = await harness.runtime.tick({ concurrency: 4 });

    assert.equal(result.runs.length, 2);
    assert.equal(overlap.maxActive, 2);
    for (const run of result.runs) {
      assert.equal(harness.runtime.getInvocation(run.id).lane, null);
    }
  });

  it("can give an existing schedule a lane afterwards", async (t) => {
    const { harness } = scheduleHarness(t, null);
    harness.store.updateSchedule("poll-slack", {
      lane: "source:slack",
      updatedAt: harness.now(),
    });
    assert.equal(harness.runtime.getSchedule("poll-slack").lane, "source:slack");

    harness.advance(MINUTE);
    const [materialized] = harness.runtime.materializeSchedules();

    assert.equal(
      harness.runtime.getInvocation(materialized.created[0].id).lane,
      "source:slack",
    );
  });

  it("rejects an empty lane on both schedule kinds", (t) => {
    const { harness } = createHarness(t);

    assert.throws(
      () =>
        harness.runtime.createSchedule({
          id: "blank-lane",
          workflow: "gated",
          lane: " ",
          every: MINUTE,
        }),
      /lane must not be empty/,
    );
    assert.throws(
      () =>
        harness.runtime.createDailySchedule({
          id: "blank-lane-daily",
          workflow: "gated",
          lane: " ",
          dailyAt: "09:00",
          timezone: "Asia/Tokyo",
        }),
      /lane must not be empty/,
    );
    const daily = harness.runtime.createDailySchedule({
      id: "daily-poll",
      workflow: "gated",
      lane: "source:slack",
      dailyAt: "09:00",
      timezone: "Asia/Tokyo",
    });
    assert.equal(daily.lane, "source:slack");
  });
});
