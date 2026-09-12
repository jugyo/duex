import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { defineWorkflow } from "../../../src/core/types.ts";
import type { WorkflowContext } from "../../../src/core/types.ts";

/**
 * Fixture app for the crash matrix. `DUEX_CRASH_AT` selects a crash
 * point of the form `before:<step>` or `after:<step>`; the process is killed
 * with `process.exit` so nothing is flushed beyond what already reached SQLite.
 */

function record(name: string): void {
  const path = process.env.DUEX_STEP_LOG;
  if (path) appendFileSync(path, `${name}\n`, "utf8");
}

function maybeCrash(marker: string): void {
  if (process.env.DUEX_CRASH_AT === marker) process.exit(9);
}

async function step<T>(ctx: WorkflowContext, name: string, value: T): Promise<T> {
  return ctx.run(name, () => {
    maybeCrash(`before:${name}`);
    record(name);
    maybeCrash(`after:${name}`);
    return value;
  });
}

export const crashWorkflow = defineWorkflow({
  name: "crash-workflow",
  version: "1",
  async run(ctx: WorkflowContext) {
    const first = await step(ctx, "step-one", "one");
    const second = await step(ctx, "step-two", "two");
    const third = await step(ctx, "step-three", "three");
    return { first, second, third };
  },
});

export const slowWorkflow = defineWorkflow({
  name: "slow-workflow",
  version: "1",
  async run(ctx: WorkflowContext) {
    return ctx.run("slow", async () => {
      await delay(Number(process.env.DUEX_SLOW_MS ?? 700));
      record("slow");
      return "done";
    });
  },
});
