import { defineWorkflow } from "../../../src/core/types.ts";
import type { WorkflowContext } from "../../../src/core/types.ts";

export interface HelloInput {
  name?: string;
}

export interface HelloOutput {
  greeting: string;
  greetedAt: string;
  runId: string;
}

/** Phase 1 walking skeleton: three journaled operations, no external I/O. */
export const helloWorkflow = defineWorkflow<HelloInput, HelloOutput>({
  name: "hello-workflow",
  version: "1",
  async run(ctx: WorkflowContext, input: HelloInput): Promise<HelloOutput> {
    const name = input?.name ?? "world";
    const greeting = await ctx.run("greeting.build", () => `hello, ${name}!`);
    const greetedAt = await ctx.now("greeting.time");
    const runId = await ctx.uuid("greeting.run-id");

    return {
      greeting,
      greetedAt: greetedAt.toISOString(),
      runId,
    };
  },
});
