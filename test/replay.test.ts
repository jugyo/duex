import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InvocationRunner } from "../src/core/runner.ts";
import { WorkflowRegistry } from "../src/core/registry.ts";
import { TerminalError, defineWorkflow } from "../src/index.ts";
import { silentLogger } from "../src/core/logger.ts";
import { createTestRuntime } from "./helpers.ts";
import type { WorkflowContext, WorkflowDefinition } from "../src/core/types.ts";
import type { TestRuntime } from "./helpers.ts";

/** Re-queue a resting invocation so the handler replays from the top. */
function requeue(harness: TestRuntime, id: string): void {
  harness.store.updateInvocation(id, {
    status: "pending",
    availableAt: harness.now(),
    updatedAt: harness.now(),
  });
}

async function start(
  harness: TestRuntime,
  workflow: string,
  input: unknown = null,
): Promise<string> {
  const { invocation } = await harness.runtime.invoke({ workflow, input });
  return invocation.id;
}

describe("ctx.run replay", () => {
  it("executes a completed step exactly once across 100 replays", async (t) => {
    let calls = 0;
    const workflow = defineWorkflow({
      name: "counter",
      version: "1",
      async run(ctx: WorkflowContext) {
        const value = await ctx.run("step.once", () => {
          calls += 1;
          return { calls };
        });
        return value;
      },
    });

    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "counter");
    const first = await harness.runner.run(id);
    assert.equal(first.outcome, "completed");
    assert.equal(calls, 1);

    for (let index = 0; index < 100; index += 1) {
      requeue(harness, id);
      const result = await harness.runner.run(id);
      assert.equal(result.outcome, "completed");
    }

    assert.equal(calls, 1, "the callback must not run again on replay");
    const invocation = harness.runtime.getInvocation(id);
    assert.deepEqual(invocation.output, { calls: 1 });
    assert.equal(harness.runtime.getJournal(id).length, 1);
  });

  it("returns journaled values for ctx.now and ctx.uuid", async (t) => {
    const workflow = defineWorkflow({
      name: "clocked",
      version: "1",
      async run(ctx: WorkflowContext) {
        const at = await ctx.now("clock");
        const id = await ctx.uuid("id");
        return { at: at.toISOString(), id };
      },
    });

    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "clocked");
    await harness.runner.run(id);
    const first = harness.runtime.getInvocation(id).output;

    harness.advance(60_000);
    requeue(harness, id);
    await harness.runner.run(id);

    assert.deepEqual(harness.runtime.getInvocation(id).output, first);
  });

  it("supports void steps", async (t) => {
    let calls = 0;
    const workflow = defineWorkflow({
      name: "void-step",
      version: "1",
      async run(ctx: WorkflowContext) {
        const value = await ctx.run("notify", () => {
          calls += 1;
        });
        return { value: value === undefined ? "undefined" : "defined" };
      },
    });

    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "void-step");
    await harness.runner.run(id);
    assert.deepEqual(harness.runtime.getInvocation(id).output, { value: "undefined" });

    requeue(harness, id);
    await harness.runner.run(id);
    assert.equal(calls, 1);
    assert.deepEqual(harness.runtime.getInvocation(id).output, { value: "undefined" });
  });

  it("rejects output that cannot be journaled", async (t) => {
    const workflow = defineWorkflow({
      name: "bad-output",
      version: "1",
      async run(ctx: WorkflowContext) {
        return ctx.run("build", () => ({ when: new Date() }));
      },
    });

    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "bad-output");
    const result = await harness.runner.run(id);
    assert.equal(result.outcome, "failed");
    assert.equal(harness.runtime.getInvocation(id).error?.code, "SERIALIZATION");
  });
});

describe("determinism contract", () => {
  it("stops when the journal no longer matches the handler", async (t) => {
    const original = defineWorkflow({
      name: "shifting",
      version: "1",
      async run(ctx: WorkflowContext) {
        await ctx.run("first", () => 1);
        await ctx.run("second", () => 2);
        return "done";
      },
    });
    const edited: WorkflowDefinition = {
      name: "shifting",
      version: "1",
      async run(ctx: WorkflowContext) {
        await ctx.run("first", () => 1);
        await ctx.run("inserted", () => 99);
        await ctx.run("second", () => 2);
        return "done";
      },
    };

    const harness = createTestRuntime({ workflows: [original] });
    t.after(harness.close);

    const id = await start(harness, "shifting");
    await harness.runner.run(id);

    const editedRunner = new InvocationRunner({
      store: harness.store,
      registry: new WorkflowRegistry([edited]),
      logger: silentLogger,
      now: harness.now,
    });
    requeue(harness, id);
    const result = await editedRunner.run(id);

    assert.equal(result.outcome, "failed");
    const error = harness.runtime.getInvocation(id).error;
    assert.equal(error?.code, "NON_DETERMINISTIC");
    assert.match(error?.message ?? "", /seq 1/);
  });

  it("rejects concurrent durable operations", async (t) => {
    const workflow = defineWorkflow({
      name: "parallel",
      version: "1",
      async run(ctx: WorkflowContext) {
        return Promise.all([
          ctx.run("a", async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return 1;
          }),
          ctx.run("b", () => 2),
        ]);
      },
    });

    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "parallel");
    const result = await harness.runner.run(id);
    assert.equal(result.outcome, "failed");
    assert.equal(harness.runtime.getInvocation(id).error?.code, "NON_DETERMINISTIC");
  });

  it("rejects ctx.* calls nested inside a ctx.run callback", async (t) => {
    const workflow = defineWorkflow({
      name: "nested",
      version: "1",
      async run(ctx: WorkflowContext) {
        return ctx.run("outer", async () => ctx.run("inner", () => 1));
      },
    });

    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "nested");
    const result = await harness.runner.run(id);
    assert.equal(result.outcome, "failed");
    assert.equal(harness.runtime.getInvocation(id).error?.code, "NON_DETERMINISTIC");
  });

  it("refuses to run an invocation pinned to another workflow version", async (t) => {
    const v1 = defineWorkflow({
      name: "versioned",
      version: "1",
      async run(ctx: WorkflowContext) {
        return ctx.run("step", () => "v1");
      },
    });
    const v2: WorkflowDefinition = {
      name: "versioned",
      version: "2",
      async run(ctx: WorkflowContext) {
        return ctx.run("step", () => "v2");
      },
    };

    const harness = createTestRuntime({ workflows: [v1] });
    t.after(harness.close);
    const id = await start(harness, "versioned");

    const upgraded = new InvocationRunner({
      store: harness.store,
      registry: new WorkflowRegistry([v2]),
      logger: silentLogger,
      now: harness.now,
    });
    const result = await upgraded.run(id);

    assert.equal(result.outcome, "skipped");
    assert.match(result.reason ?? "", /pinned to versioned@1/);
    assert.equal(harness.runtime.getInvocation(id).status, "pending");
  });
});

describe("retry and terminal failure", () => {
  it("backs off in the journal and resumes after the retry becomes due", async (t) => {
    let attempts = 0;
    const workflow = defineWorkflow({
      name: "flaky",
      version: "1",
      async run(ctx: WorkflowContext) {
        return ctx.run(
          "external.call",
          () => {
            attempts += 1;
            if (attempts < 3) throw new Error(`transient ${attempts}`);
            return "ok";
          },
          { retry: { maxAttempts: 5, initialDelayMs: 100, factor: 2 } },
        );
      },
    });

    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "flaky");

    const first = await harness.runner.run(id);
    assert.equal(first.outcome, "retry_wait");
    assert.equal(harness.runtime.getInvocation(id).status, "retry_wait");
    assert.equal(harness.runtime.getJournal(id)[0].attempt, 1);
    assert.equal(
      harness.runtime.getInvocation(id).availableAt,
      harness.now() + 100,
    );

    harness.advance(100);
    harness.store.wakeDueInvocations(harness.now());
    const second = await harness.runner.run(id);
    assert.equal(second.outcome, "retry_wait");
    assert.equal(
      harness.runtime.getInvocation(id).availableAt,
      harness.now() + 200,
    );

    harness.advance(200);
    harness.store.wakeDueInvocations(harness.now());
    const third = await harness.runner.run(id);
    assert.equal(third.outcome, "completed");
    assert.equal(attempts, 3);
    assert.equal(harness.runtime.getInvocation(id).output, "ok");
  });

  it("fails immediately on TerminalError without consuming retries", async (t) => {
    let attempts = 0;
    const workflow = defineWorkflow({
      name: "terminal",
      version: "1",
      async run(ctx: WorkflowContext) {
        return ctx.run(
          "reject",
          () => {
            attempts += 1;
            throw new TerminalError("permanently invalid input");
          },
          { retry: { maxAttempts: 9, initialDelayMs: 10 } },
        );
      },
    });

    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "terminal");
    const result = await harness.runner.run(id);

    assert.equal(result.outcome, "failed");
    assert.equal(attempts, 1);
    const invocation = harness.runtime.getInvocation(id);
    assert.equal(invocation.status, "failed");
    assert.equal(invocation.error?.terminal, true);
    assert.equal(harness.runtime.getJournal(id)[0].status, "failed");
  });

  it("fails once the retry budget is exhausted, and manual retry resumes it", async (t) => {
    let attempts = 0;
    let succeedNow = false;
    const workflow = defineWorkflow({
      name: "exhausted",
      version: "1",
      async run(ctx: WorkflowContext) {
        return ctx.run(
          "external.call",
          () => {
            attempts += 1;
            if (!succeedNow) throw new Error("still broken");
            return "recovered";
          },
          { retry: { maxAttempts: 2, initialDelayMs: 50 } },
        );
      },
    });

    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "exhausted");
    assert.equal((await harness.runner.run(id)).outcome, "retry_wait");
    harness.advance(50);
    harness.store.wakeDueInvocations(harness.now());
    assert.equal((await harness.runner.run(id)).outcome, "failed");
    assert.equal(attempts, 2);

    succeedNow = true;
    const requeued = harness.runtime.retryInvocation(id);
    assert.equal(requeued.status, "pending");
    assert.equal(harness.runtime.getJournal(id).length, 0, "failed entries are cleared");

    assert.equal((await harness.runner.run(id)).outcome, "completed");
    assert.equal(harness.runtime.getInvocation(id).output, "recovered");
  });

  it("only allows manual retry from failed", async (t) => {
    const workflow = defineWorkflow({
      name: "healthy",
      version: "1",
      async run(ctx: WorkflowContext) {
        return ctx.run("step", () => "ok");
      },
    });
    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "healthy");
    await harness.runner.run(id);
    assert.throws(() => harness.runtime.retryInvocation(id), /only failed/);
  });
});

describe("ctx.sleep", () => {
  it("persists the timer and continues after the wake time", async (t) => {
    let before = 0;
    let after = 0;
    const workflow = defineWorkflow({
      name: "sleeper",
      version: "1",
      async run(ctx: WorkflowContext) {
        await ctx.run("before", () => {
          before += 1;
          return "before";
        });
        await ctx.sleep("wait", "1h");
        return ctx.run("after", () => {
          after += 1;
          return "after";
        });
      },
    });

    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "sleeper");
    const first = await harness.runner.run(id);
    assert.equal(first.outcome, "sleeping");

    const sleeping = harness.runtime.getInvocation(id);
    assert.equal(sleeping.status, "sleeping");
    assert.equal(sleeping.availableAt, harness.now() + 3_600_000);
    assert.equal(before, 1);
    assert.equal(after, 0);

    // Not due yet: the runner leaves it alone.
    harness.advance(60_000);
    assert.equal(harness.store.wakeDueInvocations(harness.now()), 0);

    harness.advance(3_600_000);
    assert.equal(harness.store.wakeDueInvocations(harness.now()), 1);
    const second = await harness.runner.run(id);

    assert.equal(second.outcome, "completed");
    assert.equal(before, 1, "the step before the sleep is replayed from the journal");
    assert.equal(after, 1);
    assert.equal(harness.runtime.getInvocation(id).output, "after");
  });
});

describe("cooperative cancellation", () => {
  it("stops at the next operation boundary", async (t) => {
    let second = 0;
    const harness = createTestRuntime({ workflows: [] });
    t.after(harness.close);

    const workflow = defineWorkflow({
      name: "cancellable",
      version: "1",
      async run(ctx: WorkflowContext) {
        await ctx.run("first", () => "first");
        // Simulates another process cancelling between operations.
        harness.store.updateInvocation(ctx.invocationId, {
          status: "cancelled",
          updatedAt: harness.now(),
        });
        await ctx.run("second", () => {
          second += 1;
          return "second";
        });
        return "done";
      },
    });
    harness.registry.register(workflow);

    const id = await start(harness, "cancellable");
    const result = await harness.runner.run(id);

    assert.equal(result.outcome, "cancelled");
    assert.equal(second, 0);
    assert.equal(harness.runtime.getInvocation(id).status, "cancelled");
  });

  it("refuses to cancel terminal invocations", async (t) => {
    const workflow = defineWorkflow({
      name: "quick",
      version: "1",
      async run(ctx: WorkflowContext) {
        return ctx.run("step", () => "ok");
      },
    });
    const harness = createTestRuntime({ workflows: [workflow] });
    t.after(harness.close);

    const id = await start(harness, "quick");
    await harness.runner.run(id);
    assert.throws(() => harness.runtime.cancelInvocation(id), /already completed/);
  });
});
