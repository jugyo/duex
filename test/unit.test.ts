import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { backoffDelayMs, formatDuration, parseDuration } from "../src/core/duration.ts";
import {
  assertJson,
  canonicalStringify,
  decodePayload,
  encodePayload,
  MAX_PAYLOAD_BYTES,
} from "../src/core/json.ts";
import { SerializationError, UsageError, serializeError, deserializeError, TerminalError } from "../src/core/errors.ts";
import { plannedSlots, scheduleIdempotencyKey } from "../src/core/scheduler.ts";
import { newInvocationId } from "../src/core/ids.ts";
import { JsonLogger } from "../src/core/logger.ts";

describe("JsonLogger", () => {
  it("does not let a writer failure change the caller result", () => {
    const logger = new JsonLogger({ write: () => { throw new Error("broken output"); } });
    assert.doesNotThrow(() => logger.info("test.event", { ok: true }));
  });
});

describe("parseDuration", () => {
  it("parses single units", () => {
    assert.equal(parseDuration("250ms"), 250);
    assert.equal(parseDuration("30s"), 30_000);
    assert.equal(parseDuration("5m"), 300_000);
    assert.equal(parseDuration("1h"), 3_600_000);
    assert.equal(parseDuration("2d"), 172_800_000);
  });

  it("parses compound durations and bare numbers", () => {
    assert.equal(parseDuration("1h30m"), 5_400_000);
    assert.equal(parseDuration("1h 30m 15s"), 5_415_000);
    assert.equal(parseDuration("1500"), 1500);
    assert.equal(parseDuration(750), 750);
  });

  it("rejects nonsense", () => {
    assert.throws(() => parseDuration("soon"), UsageError);
    assert.throws(() => parseDuration("10x"), UsageError);
    assert.throws(() => parseDuration(""), UsageError);
    assert.throws(() => parseDuration(-1), UsageError);
  });
});

describe("formatDuration", () => {
  it("round-trips through parseDuration", () => {
    for (const ms of [1, 999, 1000, 61_000, 5_415_000, 172_800_000]) {
      assert.equal(parseDuration(formatDuration(ms)), ms);
    }
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially and honours the cap", () => {
    const policy = { initialDelayMs: 250, factor: 2, maxDelayMs: 5000 };
    assert.equal(backoffDelayMs(0, policy), 250);
    assert.equal(backoffDelayMs(1, policy), 500);
    assert.equal(backoffDelayMs(2, policy), 1000);
    assert.equal(backoffDelayMs(10, policy), 5000);
  });

  it("defaults to a factor of 2", () => {
    assert.equal(backoffDelayMs(3, { initialDelayMs: 100 }), 800);
  });
});

describe("canonical JSON", () => {
  it("sorts object keys at every depth", () => {
    const text = canonicalStringify({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } });
    assert.equal(text, '{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}');
  });

  it("produces identical text for equivalent objects", () => {
    assert.equal(
      canonicalStringify({ x: 1, y: 2 }),
      canonicalStringify({ y: 2, x: 1 }),
    );
  });
});

describe("assertJson", () => {
  it("accepts JSON values", () => {
    const value = { a: [1, "two", true, null], b: { c: 0.5 } };
    assert.deepEqual(assertJson(value, "v"), value);
  });

  it("rejects undefined, functions, symbols and class instances", () => {
    assert.throws(() => assertJson(undefined, "v"), SerializationError);
    assert.throws(() => assertJson({ a: undefined }, "v"), SerializationError);
    assert.throws(() => assertJson(() => 1, "v"), SerializationError);
    assert.throws(() => assertJson({ s: Symbol("x") }, "v"), SerializationError);
    assert.throws(() => assertJson(new Date(), "v"), SerializationError);
    assert.throws(() => assertJson(new Map(), "v"), SerializationError);
  });

  it("rejects non-finite numbers and circular references", () => {
    assert.throws(() => assertJson(Number.NaN, "v"), SerializationError);
    assert.throws(() => assertJson(Infinity, "v"), SerializationError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => assertJson(circular, "v"), SerializationError);
  });

  it("names the offending path", () => {
    assert.throws(
      () => assertJson({ a: { b: [1, undefined] } }, "output"),
      /output\.a\.b\[1\]/,
    );
  });
});

describe("payload encoding", () => {
  it("encodes void as SQL NULL and null as JSON null", () => {
    assert.equal(encodePayload(undefined, "v"), null);
    assert.equal(encodePayload(null, "v"), "null");
    assert.equal(decodePayload(null), undefined);
    assert.equal(decodePayload("null"), null);
  });

  it("enforces the 1 MiB per-entry limit", () => {
    const big = { blob: "x".repeat(MAX_PAYLOAD_BYTES) };
    assert.throws(() => encodePayload(big, "output"), SerializationError);
  });
});

describe("error serialization", () => {
  it("round-trips terminal errors", () => {
    const serialized = serializeError(new TerminalError("nope", { why: "test" }));
    assert.equal(serialized.terminal, true);
    assert.equal(serialized.code, "TERMINAL");
    const rebuilt = deserializeError(serialized);
    assert.equal(rebuilt.message, "nope");
    assert.ok(rebuilt instanceof TerminalError);
  });

  it("marks plain errors as retryable", () => {
    assert.equal(serializeError(new Error("flaky")).terminal, false);
  });
});

describe("plannedSlots", () => {
  const base = { everyMs: 3_600_000, maxCatchUp: 100 };
  const nextRunAt = 1_000_000;

  it("returns nothing before the schedule is due", () => {
    const plan = plannedSlots({ ...base, nextRunAt, catchUp: "latest" }, nextRunAt - 1);
    assert.deepEqual(plan.times, []);
    assert.equal(plan.nextRunAt, nextRunAt);
  });

  it("latest keeps only the newest missed slot", () => {
    const now = nextRunAt + 4 * base.everyMs + 5;
    const plan = plannedSlots({ ...base, nextRunAt, catchUp: "latest" }, now);
    assert.deepEqual(plan.times, [nextRunAt + 4 * base.everyMs]);
    assert.equal(plan.dropped, 4);
    assert.ok(plan.nextRunAt > now);
  });

  it("all replays every missed slot oldest first", () => {
    const now = nextRunAt + 4 * base.everyMs;
    const plan = plannedSlots({ ...base, nextRunAt, catchUp: "all" }, now);
    assert.equal(plan.times.length, 5);
    assert.equal(plan.times[0], nextRunAt);
    assert.equal(plan.deferred, 0);
  });

  it("all defers beyond maxCatchUp instead of dropping", () => {
    const now = nextRunAt + 9 * base.everyMs;
    const plan = plannedSlots(
      { ...base, maxCatchUp: 3, nextRunAt, catchUp: "all" },
      now,
    );
    assert.equal(plan.times.length, 3);
    assert.equal(plan.deferred, 7);
    assert.equal(plan.nextRunAt, nextRunAt + 3 * base.everyMs);
  });

  it("skip creates nothing but advances past now", () => {
    const now = nextRunAt + 3 * base.everyMs + 1;
    const plan = plannedSlots({ ...base, nextRunAt, catchUp: "skip" }, now);
    assert.deepEqual(plan.times, []);
    assert.equal(plan.dropped, 4);
    assert.ok(plan.nextRunAt > now);
  });
});

describe("ids", () => {
  it("produces sortable invocation ids", () => {
    const early = newInvocationId(1_000_000);
    const late = newInvocationId(2_000_000);
    assert.ok(early < late);
    assert.equal(early.length, 26);
  });

  it("derives deterministic schedule idempotency keys", () => {
    assert.equal(scheduleIdempotencyKey("hourly", 42), "schedule:hourly:42");
  });
});
