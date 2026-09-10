import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RuntimeApi } from "../src/core/runtime-api.ts";
import { SqliteStore } from "../src/storage/sqlite-store.ts";
import { WorkflowRegistry } from "../src/core/registry.ts";
import { defineWorkflow } from "../src/index.ts";
import { silentLogger } from "../src/core/logger.ts";
import { createTestRuntime, tempDbPath } from "./helpers.ts";
import type { WorkflowContext } from "../src/core/types.ts";

const echo = defineWorkflow({
  name: "echo",
  version: "1",
  async run(ctx: WorkflowContext, input: { value?: string }) {
    return ctx.run("echo", () => ({ value: input?.value ?? null }));
  },
});

describe("invocation idempotency", () => {
  it("returns the same invocation id for a repeated key", async (t) => {
    const harness = createTestRuntime({ workflows: [echo] });
    t.after(harness.close);

    const first = await harness.runtime.invoke({
      workflow: "echo",
      input: { value: "a" },
      idempotencyKey: "daily-2026-08-31",
    });
    const second = await harness.runtime.invoke({
      workflow: "echo",
      input: { value: "b" },
      idempotencyKey: "daily-2026-08-31",
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.invocation.id, first.invocation.id);
    assert.deepEqual(second.invocation.input, { value: "a" }, "the first input wins");
    assert.equal(harness.runtime.listInvocations({}).length, 1);
  });

  it("keeps the key scoped to one workflow", async (t) => {
    const other = defineWorkflow({
      name: "echo-2",
      version: "1",
      async run(ctx: WorkflowContext) {
        return ctx.run("echo", () => "ok");
      },
    });
    const harness = createTestRuntime({ workflows: [echo, other] });
    t.after(harness.close);

    const a = await harness.runtime.invoke({ workflow: "echo", idempotencyKey: "k" });
    const b = await harness.runtime.invoke({ workflow: "echo-2", idempotencyKey: "k" });
    assert.notEqual(a.invocation.id, b.invocation.id);
  });

  it("allows any number of invocations without a key", async (t) => {
    const harness = createTestRuntime({ workflows: [echo] });
    t.after(harness.close);

    await harness.runtime.invoke({ workflow: "echo" });
    await harness.runtime.invoke({ workflow: "echo" });
    assert.equal(harness.runtime.listInvocations({}).length, 2);
  });

  it("resolves a concurrent insert race to a single invocation", async (t) => {
    const harness = createTestRuntime({ workflows: [echo] });
    t.after(harness.close);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.runtime.invoke({ workflow: "echo", idempotencyKey: "race" }),
      ),
    );
    const ids = new Set(results.map((result) => result.invocation.id));
    assert.equal(ids.size, 1);
    assert.equal(results.filter((result) => result.created).length, 1);
  });

  it("rejects unknown workflows and empty keys", async (t) => {
    const harness = createTestRuntime({ workflows: [echo] });
    t.after(harness.close);

    await assert.rejects(
      () => harness.runtime.invoke({ workflow: "nope" }),
      /unknown workflow/,
    );
    await assert.rejects(
      () => harness.runtime.invoke({ workflow: "echo", idempotencyKey: "  " }),
      /must not be empty/,
    );
  });

  it("rejects inputs that cannot be journaled", async (t) => {
    const harness = createTestRuntime({ workflows: [echo] });
    t.after(harness.close);

    await assert.rejects(
      () => harness.runtime.invoke({ workflow: "echo", input: { at: new Date() } }),
      /not JSON serializable/,
    );
  });
});

describe("single active runner", () => {
  it("lets only one runtime hold the lease at a time", async (t) => {
    const dbPath = tempDbPath(t);
    const clock = { value: Date.UTC(2026, 7, 31) };
    const now = () => clock.value;

    const open = (): RuntimeApi => {
      const runtime = new RuntimeApi({
        store: new SqliteStore({ path: dbPath }),
        registry: new WorkflowRegistry([echo]),
        logger: silentLogger,
        now,
        leaseTtlMs: 30_000,
      });
      runtime.init();
      return runtime;
    };

    const first = open();
    const second = open();
    t.after(() => {
      first.close();
      second.close();
    });

    await first.invoke({ workflow: "echo", idempotencyKey: "shared" });

    let secondSawLease: boolean | null = null;
    await first.withRunnerLease(async (acquired) => {
      assert.equal(acquired, true);
      const result = await second.tick({ maxRuns: 5 });
      secondSawLease = result.skipped;
      assert.equal(result.runs.length, 0);
    });

    assert.equal(secondSawLease, true, "the second runner must stand down");

    // Once the first runner releases, the second one can work.
    const afterRelease = await second.tick({ maxRuns: 5 });
    assert.equal(afterRelease.skipped, false);
    assert.equal(afterRelease.runs.length, 1);
    assert.equal(afterRelease.runs[0].outcome, "completed");
  });

  it("takes over once an abandoned lease expires", async (t) => {
    const dbPath = tempDbPath(t);
    const clock = { value: Date.UTC(2026, 7, 31) };
    const now = () => clock.value;

    const store = new SqliteStore({ path: dbPath });
    const runtime = new RuntimeApi({
      store,
      registry: new WorkflowRegistry([echo]),
      logger: silentLogger,
      now,
      leaseTtlMs: 10_000,
    });
    runtime.init();
    t.after(() => runtime.close());

    // A crashed runner left its lease and a claimed invocation behind.
    const { invocation } = await runtime.invoke({ workflow: "echo" });
    store.acquireLease("runner", "dead-runner", now(), 10_000);
    store.claimInvocation(invocation.id, now());
    assert.equal(runtime.getInvocation(invocation.id).status, "running");

    const blocked = await runtime.tick({ maxRuns: 5 });
    assert.equal(blocked.skipped, true);

    clock.value += 10_001;
    const recovered = await runtime.tick({ maxRuns: 5 });
    assert.equal(recovered.skipped, false);
    assert.equal(recovered.recovered, 1);
    assert.equal(recovered.runs[0].outcome, "completed");
  });
});
