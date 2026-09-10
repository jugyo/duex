import { UsageError } from "./errors.ts";
import type { Duration } from "./types.ts";

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const TOKEN = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/giu;

/**
 * Parse `"1h30m"`, `"250ms"`, `"2d"` or a plain millisecond number.
 * Bare numeric strings are treated as milliseconds.
 */
export function parseDuration(value: Duration): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new UsageError(`invalid duration: ${value}`);
    }
    return Math.round(value);
  }

  const text = String(value).trim();
  if (text === "") throw new UsageError("invalid duration: empty string");

  if (/^\d+(\.\d+)?$/u.test(text)) return Math.round(Number(text));

  let total = 0;
  let matched = 0;
  TOKEN.lastIndex = 0;
  for (const match of text.matchAll(TOKEN)) {
    total += Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
    matched += match[0].length;
  }
  if (matched === 0 || matched !== text.replace(/\s+/gu, "").length) {
    throw new UsageError(
      `invalid duration: ${JSON.stringify(text)} (expected e.g. "500ms", "30s", "1h30m")`,
    );
  }
  return Math.round(total);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1000, "s"],
  ];
  let remaining = ms;
  const parts: string[] = [];
  for (const [size, suffix] of units) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      parts.push(`${count}${suffix}`);
      remaining -= count * size;
    }
  }
  if (remaining > 0) parts.push(`${remaining}ms`);
  return parts.join("");
}

/** Exponential backoff with a cap, per `RetryPolicy`. */
export function backoffDelayMs(
  attempt: number,
  policy: { initialDelayMs: number; factor?: number; maxDelayMs?: number },
): number {
  const factor = policy.factor ?? 2;
  const raw = policy.initialDelayMs * Math.pow(factor, Math.max(0, attempt));
  const capped = Math.min(raw, policy.maxDelayMs ?? Number.MAX_SAFE_INTEGER);
  return Math.max(0, Math.round(capped));
}
