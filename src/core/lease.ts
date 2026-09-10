import { silentLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import type { Store } from "../storage/store.ts";

/** Only one process at a time may execute handlers (design doc D4). */
export const RUNNER_LEASE = "runner";

export const DEFAULT_LEASE_TTL_MS = 60_000;

export interface LeaseOptions {
  store: Store;
  name?: string;
  ownerId: string;
  ttlMs?: number;
  now?: () => number;
  logger?: Logger;
}

/**
 * A renewable, single-holder lease stored in SQLite.
 *
 * The heartbeat keeps the lease alive across long `await`s inside a handler;
 * it is unref'd so it can never keep the process alive on its own.
 */
export class RunnerLease {
  readonly name: string;
  readonly ownerId: string;
  readonly ttlMs: number;

  #store: Store;
  #now: () => number;
  #logger: Logger;
  #heartbeat: NodeJS.Timeout | null = null;
  #released = false;
  expiresAt: number;

  private constructor(options: Required<Omit<LeaseOptions, "logger">> & {
    logger: Logger;
    expiresAt: number;
  }) {
    this.#store = options.store;
    this.name = options.name;
    this.ownerId = options.ownerId;
    this.ttlMs = options.ttlMs;
    this.#now = options.now;
    this.#logger = options.logger;
    this.expiresAt = options.expiresAt;
  }

  /** Returns `null` when another live runner already holds the lease. */
  static acquire(options: LeaseOptions): RunnerLease | null {
    const store = options.store;
    const name = options.name ?? RUNNER_LEASE;
    const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    const now = options.now ?? Date.now;
    const record = store.acquireLease(name, options.ownerId, now(), ttlMs);
    if (!record) return null;
    return new RunnerLease({
      store,
      name,
      ownerId: options.ownerId,
      ttlMs,
      now,
      logger: options.logger ?? silentLogger,
      expiresAt: record.expiresAt,
    });
  }

  renew(): boolean {
    if (this.#released) return false;
    const ok = this.#store.renewLease(
      this.name,
      this.ownerId,
      this.#now(),
      this.ttlMs,
    );
    if (ok) {
      this.expiresAt = this.#now() + this.ttlMs;
    } else {
      this.#logger.warn("lease.lost", { lease: this.name, owner: this.ownerId });
    }
    return ok;
  }

  startHeartbeat(intervalMs = Math.max(100, Math.floor(this.ttlMs / 3))): void {
    if (this.#heartbeat) return;
    this.#heartbeat = setInterval(() => this.renew(), intervalMs);
    this.#heartbeat.unref?.();
  }

  stopHeartbeat(): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }

  release(): void {
    if (this.#released) return;
    this.stopHeartbeat();
    this.#released = true;
    this.#store.releaseLease(this.name, this.ownerId);
  }

  get released(): boolean {
    return this.#released;
  }
}
