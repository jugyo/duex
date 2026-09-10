import { randomUUID } from "node:crypto";

import { backoffDelayMs, parseDuration } from "./duration.ts";
import {
  InvocationCancelledError,
  NonDeterministicWorkflowError,
  SuspendInvocation,
  deserializeError,
  isTerminalError,
  serializeError,
} from "./errors.ts";
import { encodePayload, summarizePayload } from "./json.ts";
import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import type { Store } from "../storage/store.ts";
import type {
  Duration,
  JournalKind,
  JournalRecord,
  Json,
  RetryPolicy,
  RunOptions,
  WorkflowContext,
} from "./types.ts";

export const DEFAULT_RETRY: Required<RetryPolicy> = {
  maxAttempts: 3,
  initialDelayMs: 200,
  factor: 2,
  maxDelayMs: 30_000,
};

export interface ReplayContextOptions {
  store: Store;
  invocationId: string;
  workflowName: string;
  scheduledAt?: number | null;
  scheduledFrom?: number | null;
  now?: () => number;
  logger?: Logger;
  defaultRetry?: RetryPolicy;
}

/**
 * Binds `ctx.*` calls to journal entries.
 *
 * Sequence numbers are assigned in call order starting at 0, so the identity of
 * an operation is `invocationId + seq` and `kind + name` is only a consistency
 * check (design doc §7).
 */
export class ReplayContext implements WorkflowContext {
  readonly invocationId: string;
  readonly workflowName: string;
  readonly scheduledAt: Date | null;
  readonly scheduledFrom: Date | null;

  #store: Store;
  #now: () => number;
  #logger: Logger;
  #defaultRetry: Required<RetryPolicy>;
  #seq = 0;
  #busy = false;
  #replayedCount = 0;
  #executedCount = 0;

  constructor(options: ReplayContextOptions) {
    this.#store = options.store;
    this.invocationId = options.invocationId;
    this.workflowName = options.workflowName;
    this.scheduledAt = options.scheduledAt === null || options.scheduledAt === undefined
      ? null
      : new Date(options.scheduledAt);
    this.scheduledFrom = options.scheduledFrom === null || options.scheduledFrom === undefined
      ? null
      : new Date(options.scheduledFrom);
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? silentLogger;
    this.#defaultRetry = { ...DEFAULT_RETRY, ...(options.defaultRetry ?? {}) };
  }

  /** Number of durable operations consumed so far. */
  get sequence(): number {
    return this.#seq;
  }

  get stats(): { replayed: number; executed: number } {
    return { replayed: this.#replayedCount, executed: this.#executedCount };
  }

  // ------------------------------------------------------------------ ctx.run

  async run<T>(
    name: string,
    operation: () => Promise<T> | T,
    options?: RunOptions,
  ): Promise<T> {
    this.#enter("run", name);
    try {
      const seq = this.#seq++;
      const policy = { ...this.#defaultRetry, ...(options?.retry ?? {}) };
      this.#assertNotCancelled();

      const existing = this.#store.getJournalEntry(this.invocationId, seq);
      let attempt = 0;

      if (existing) {
        this.#assertMatches(existing, "run", name, seq);

        if (existing.status === "completed") {
          this.#replayedCount += 1;
          this.#logger.debug("step.replayed", {
            seq,
            name,
            attempt: existing.attempt,
          });
          return existing.output as T;
        }
        if (existing.status === "failed") {
          throw deserializeError(
            existing.error ?? {
              name: "Error",
              message: `step ${name} previously failed`,
              terminal: true,
            },
          );
        }
        if (existing.status === "retry_wait") {
          const availableAt = existing.availableAt ?? this.#now();
          if (availableAt > this.#now()) {
            throw new SuspendInvocation("retry_wait", availableAt, seq);
          }
        }
        // `running` (crashed mid-flight) or a due `retry_wait`: execute again.
        attempt = existing.attempt;
        this.#store.updateJournalEntry(this.invocationId, seq, {
          status: "running",
          startedAt: this.#now(),
        });
      } else {
        this.#store.insertJournalEntry(
          this.#newEntry(seq, "run", name, "running", {
            attempt: 0,
            startedAt: this.#now(),
          }),
        );
      }

      const startedAt = this.#now();
      this.#logger.debug("step.started", { seq, name, attempt });
      let result: T;
      try {
        // Deliberately outside any DB transaction (design doc §9).
        result = await operation();
      } catch (error) {
        throw this.#failStep(seq, name, attempt, policy, error);
      }

      let encoded: string | null;
      try {
        encoded = encodePayload(result, `${name}.output`);
      } catch (error) {
        throw this.#failStep(seq, name, attempt, policy, error, true);
      }

      const completedAt = this.#now();
      this.#store.updateJournalEntry(this.invocationId, seq, {
        status: "completed",
        attempt,
        output: result as Json | undefined,
        error: null,
        completedAt,
      });
      this.#executedCount += 1;
      this.#logger.debug("step.completed", {
        seq,
        name,
        attempt,
        durationMs: completedAt - startedAt,
        output: summarizePayload(encoded) as unknown as Json,
      });
      return result;
    } finally {
      this.#exit();
    }
  }

  // ---------------------------------------------------------------- ctx.sleep

  async sleep(name: string, duration: Duration): Promise<void> {
    this.#enter("sleep", name);
    try {
      const seq = this.#seq++;
      this.#assertNotCancelled();

      const existing = this.#store.getJournalEntry(this.invocationId, seq);
      if (existing) {
        this.#assertMatches(existing, "sleep", name, seq);
        if (existing.status === "completed") {
          this.#replayedCount += 1;
          return;
        }
        const wakeAt = existing.availableAt ?? this.#now();
        if (wakeAt > this.#now()) {
          throw new SuspendInvocation("sleeping", wakeAt, seq);
        }
        this.#store.updateJournalEntry(this.invocationId, seq, {
          status: "completed",
          completedAt: this.#now(),
        });
        this.#logger.info("sleep.completed", { seq, name, wakeAt });
        return;
      }

      const now = this.#now();
      const wakeAt = now + parseDuration(duration);
      this.#store.insertJournalEntry(
        this.#newEntry(seq, "sleep", name, "sleeping", {
          availableAt: wakeAt,
          startedAt: now,
        }),
      );
      if (wakeAt <= now) {
        this.#store.updateJournalEntry(this.invocationId, seq, {
          status: "completed",
          completedAt: now,
        });
        return;
      }
      this.#logger.info("sleep.started", { seq, name, wakeAt });
      throw new SuspendInvocation("sleeping", wakeAt, seq);
    } finally {
      this.#exit();
    }
  }

  // ------------------------------------------------------------ ctx.now/uuid

  async now(name: string): Promise<Date> {
    return new Date(
      (await this.#journaledValue("now", name, () => this.#now())) as number,
    );
  }

  async uuid(name: string): Promise<string> {
    return (await this.#journaledValue("uuid", name, () =>
      randomUUID(),
    )) as string;
  }

  async #journaledValue(
    kind: Extract<JournalKind, "now" | "uuid">,
    name: string,
    produce: () => Json,
  ): Promise<Json> {
    this.#enter(kind, name);
    try {
      const seq = this.#seq++;
      this.#assertNotCancelled();

      const existing = this.#store.getJournalEntry(this.invocationId, seq);
      if (existing) {
        this.#assertMatches(existing, kind, name, seq);
        if (existing.status === "completed") {
          this.#replayedCount += 1;
          return existing.output as Json;
        }
        this.#store.updateJournalEntry(this.invocationId, seq, {
          status: "completed",
          output: produce(),
          completedAt: this.#now(),
        });
        return this.#store.getJournalEntry(this.invocationId, seq)!
          .output as Json;
      }

      const value = produce();
      const now = this.#now();
      this.#store.insertJournalEntry(
        this.#newEntry(seq, kind, name, "completed", {
          output: value,
          startedAt: now,
          completedAt: now,
        }),
      );
      this.#executedCount += 1;
      return value;
    } finally {
      this.#exit();
    }
  }

  // ----------------------------------------------------------------- internals

  /** Always throws; typed as `never` so callers can treat it as a terminator. */
  #failStep(
    seq: number,
    name: string,
    attempt: number,
    policy: Required<RetryPolicy>,
    error: unknown,
    forceTerminal = false,
  ): never {
    const nextAttempt = attempt + 1;
    const terminal = forceTerminal || isTerminalError(error);
    const exhausted = nextAttempt >= policy.maxAttempts;

    if (terminal || exhausted) {
      const serialized = serializeError(error);
      this.#store.updateJournalEntry(this.invocationId, seq, {
        status: "failed",
        attempt: nextAttempt,
        error: serialized,
        completedAt: this.#now(),
      });
      this.#logger.debug("step.failed", {
        seq,
        name,
        attempt: nextAttempt,
        terminal,
        exhausted,
        message: serialized.message,
      });
      throw error;
    }

    const delayMs = backoffDelayMs(attempt, policy);
    const availableAt = this.#now() + delayMs;
    this.#store.updateJournalEntry(this.invocationId, seq, {
      status: "retry_wait",
      attempt: nextAttempt,
      availableAt,
      error: serializeError(error),
    });
    this.#logger.warn("step.retry_scheduled", {
      seq,
      name,
      attempt: nextAttempt,
      maxAttempts: policy.maxAttempts,
      delayMs,
      availableAt,
    });
    throw new SuspendInvocation("retry_wait", availableAt, seq);
  }

  #newEntry(
    seq: number,
    kind: JournalKind,
    name: string,
    status: JournalRecord["status"],
    extra: Partial<JournalRecord> = {},
  ): JournalRecord {
    return {
      invocationId: this.invocationId,
      seq,
      kind,
      name,
      status,
      attempt: 0,
      availableAt: null,
      output: undefined,
      error: null,
      startedAt: null,
      completedAt: null,
      ...extra,
    };
  }

  #assertMatches(
    entry: JournalRecord,
    kind: JournalKind,
    name: string,
    seq: number,
  ): void {
    if (entry.kind === kind && entry.name === name) return;
    throw new NonDeterministicWorkflowError(
      `journal mismatch at seq ${seq} of invocation ${this.invocationId}: ` +
        `expected ${entry.kind}(${JSON.stringify(entry.name)}) from the journal ` +
        `but the handler called ${kind}(${JSON.stringify(name)}). ` +
        `The workflow code changed; bump the workflow version.`,
      {
        seq,
        journal: { kind: entry.kind, name: entry.name },
        handler: { kind, name },
      },
    );
  }

  #assertNotCancelled(): void {
    const invocation = this.#store.getInvocation(this.invocationId);
    if (invocation && invocation.status === "cancelled") {
      throw new InvocationCancelledError(this.invocationId);
    }
  }

  #enter(kind: JournalKind, name: string): void {
    if (this.#busy) {
      throw new NonDeterministicWorkflowError(
        `concurrent durable operation ${kind}(${JSON.stringify(name)}) in ` +
          `invocation ${this.invocationId}: another ctx.* call is still in ` +
          `flight. Await each ctx.* call in order, and never call ctx.* from ` +
          `inside a ctx.run() callback.`,
        { kind, name },
      );
    }
    this.#busy = true;
  }

  #exit(): void {
    this.#busy = false;
  }
}
