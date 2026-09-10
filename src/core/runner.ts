import {
  ConfigError,
  InvocationCancelledError,
  SuspendInvocation,
  serializeError,
} from "./errors.ts";
import { encodePayload, summarizePayload } from "./json.ts";
import { silentLogger } from "./logger.ts";
import { ReplayContext } from "./replay-context.ts";
import type { Logger } from "./logger.ts";
import type { WorkflowRegistry } from "./registry.ts";
import type { Store } from "../storage/store.ts";
import type { InvocationRecord, Json, RetryPolicy } from "./types.ts";

function invocationPluginId(input: Json): string | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    && typeof input.pluginId === "string" ? input.pluginId : null;
}

export type RunOutcome =
  | "completed"
  | "failed"
  | "sleeping"
  | "retry_wait"
  | "cancelled"
  | "skipped";

export interface InvocationResult {
  id: string;
  outcome: RunOutcome;
  invocation: InvocationRecord;
  /** Set when `outcome === "skipped"`: why the runner refused to execute. */
  reason?: string;
  durationMs: number;
  steps: { replayed: number; executed: number };
}

export interface InvocationRunnerOptions {
  store: Store;
  registry: WorkflowRegistry;
  logger?: Logger;
  now?: () => number;
  defaultRetry?: RetryPolicy;
  /** Renews the runner lease around each invocation. */
  onProgress?: () => void;
}

/**
 * Claims a single invocation and replays its handler from the top.
 *
 * The runner owns every status transition; the handler and the replay context
 * only decide *what* the next state should be.
 */
export class InvocationRunner {
  #store: Store;
  #registry: WorkflowRegistry;
  #logger: Logger;
  #now: () => number;
  #defaultRetry: RetryPolicy | undefined;
  #onProgress: (() => void) | undefined;

  constructor(options: InvocationRunnerOptions) {
    this.#store = options.store;
    this.#registry = options.registry;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.#defaultRetry = options.defaultRetry;
    this.#onProgress = options.onProgress;
  }

  /**
   * Claim `id` and run it to completion or to its next suspension point.
   * Returns a `skipped` result when the invocation is not runnable here.
   */
  async run(id: string): Promise<InvocationResult> {
    const startedAt = this.#now();
    const invocation = this.#store.getInvocation(id);
    if (!invocation) {
      throw new ConfigError(`invocation ${id} not found`);
    }

    const skip = (reason: string, record = invocation): InvocationResult => ({
      id,
      outcome: "skipped",
      invocation: record,
      reason,
      durationMs: this.#now() - startedAt,
      steps: { replayed: 0, executed: 0 },
    });

    if (invocation.status !== "pending") {
      return skip(`invocation is ${invocation.status}, not pending`);
    }
    if (invocation.availableAt > this.#now()) {
      return skip(`invocation is not due until ${invocation.availableAt}`);
    }

    const workflow = this.#registry.get(invocation.workflowName);
    if (!workflow) {
      this.#logger.warn("invocation.unknown_workflow", {
        id,
        workflow: invocation.workflowName,
      });
      return skip(`workflow ${invocation.workflowName} is not registered`);
    }
    if (workflow.version !== invocation.workflowVersion) {
      this.#logger.warn("invocation.version_mismatch", {
        id,
        workflow: invocation.workflowName,
        invocationVersion: invocation.workflowVersion,
        registeredVersion: workflow.version,
      });
      return skip(
        `invocation pinned to ${invocation.workflowName}@${invocation.workflowVersion} ` +
          `but ${workflow.version} is registered`,
      );
    }

    if (!this.#store.claimInvocation(id, this.#now())) {
      return skip("invocation was claimed by another runner");
    }

    this.#onProgress?.();

    const logger = this.#logger.child({
      invocationId: id,
      workflow: invocation.workflowName,
      workflowVersion: invocation.workflowVersion,
      ...(invocationPluginId(invocation.input) ? { pluginId: invocationPluginId(invocation.input) } : {}),
    });
    logger.info("invocation.started", {});

    const context = new ReplayContext({
      store: this.#store,
      invocationId: id,
      workflowName: invocation.workflowName,
      scheduledAt: invocation.scheduledAt,
      scheduledFrom: invocation.scheduledFrom,
      now: this.#now,
      logger,
      defaultRetry: this.#defaultRetry,
    });

    let outcome: RunOutcome;
    try {
      const output = await workflow.run(context, invocation.input);
      const encoded = encodePayload(output, "workflow.output");
      const now = this.#now();
      this.#store.updateInvocation(id, {
        status: "completed",
        availableAt: now,
        output: output as Json | undefined,
        error: null,
        updatedAt: now,
      });
      outcome = "completed";
      logger.info("invocation.completed", {
        durationMs: now - startedAt,
        steps: context.stats as unknown as Json,
        output: summarizePayload(encoded) as unknown as Json,
      });
    } catch (error) {
      outcome = this.#handleFailure(id, error, logger, startedAt);
    } finally {
      this.#onProgress?.();
    }

    const finalRecord = this.#store.getInvocation(id)!;
    return {
      id,
      outcome,
      invocation: finalRecord,
      durationMs: this.#now() - startedAt,
      steps: context.stats,
    };
  }

  #handleFailure(
    id: string,
    error: unknown,
    logger: Logger,
    startedAt: number,
  ): RunOutcome {
    const now = this.#now();

    if (error instanceof SuspendInvocation) {
      this.#store.updateInvocation(id, {
        status: error.status,
        availableAt: error.availableAt,
        updatedAt: now,
      });
      logger.info("invocation.suspended", {
        status: error.status,
        seq: error.seq,
        availableAt: error.availableAt,
        durationMs: now - startedAt,
      });
      return error.status;
    }

    if (error instanceof InvocationCancelledError) {
      this.#store.updateInvocation(id, {
        status: "cancelled",
        availableAt: now,
        updatedAt: now,
      });
      logger.info("invocation.cancelled", { durationMs: now - startedAt });
      return "cancelled";
    }

    const serialized = serializeError(error);
    this.#store.updateInvocation(id, {
      status: "failed",
      availableAt: now,
      error: serialized,
      updatedAt: now,
    });
    logger.error("invocation.failed", {
      durationMs: now - startedAt,
      errorName: serialized.name,
      message: serialized.message,
      code: serialized.code ?? null,
    });
    return "failed";
  }
}
