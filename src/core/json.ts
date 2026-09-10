import { SerializationError } from "./errors.ts";
import type { Json } from "./types.ts";

/** Maximum size of a single journal payload (design doc §6). */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type !== "object") return type;
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return "object";
  return (value as object).constructor?.name ?? "object";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Validate that `value` can cross the durability boundary and return it typed
 * as `Json`. Rejects `undefined`, functions, symbols, class instances, streams,
 * non-finite numbers and circular references.
 */
export function assertJson(value: unknown, label: string): Json {
  return check(value, label, new Set());
}

function check(value: unknown, path: string, seen: Set<object>): Json {
  if (value === null) return null;

  const type = typeof value;
  if (type === "string" || type === "boolean") return value as Json;

  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new SerializationError(
        `${path}: non-finite number (${String(value)}) is not JSON serializable`,
      );
    }
    return value as Json;
  }

  if (type === "undefined") {
    throw new SerializationError(`${path}: \`undefined\` is not JSON serializable`);
  }

  if (type !== "object") {
    throw new SerializationError(
      `${path}: value of type \`${describe(value)}\` is not JSON serializable`,
    );
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new SerializationError(`${path}: circular reference is not JSON serializable`);
  }
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => check(item, `${path}[${index}]`, seen));
    }
    if (!isPlainObject(value)) {
      throw new SerializationError(
        `${path}: value of type \`${describe(value)}\` is not JSON serializable; ` +
          `return a plain object instead`,
      );
    }
    const result: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = check(item, `${path}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(object);
  }
}

/** Deterministic JSON text: object keys are emitted in sorted order. */
export function canonicalStringify(value: Json): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

/**
 * Validate, canonicalize and size-check a payload.
 *
 * A top-level `undefined` encodes a void step and is stored as SQL `NULL`,
 * which keeps it distinguishable from a step that genuinely returned `null`.
 */
export function encodePayload(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  const json = assertJson(value, label);
  const text = canonicalStringify(json);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new SerializationError(
      `${label}: payload of ${bytes} bytes exceeds the ${MAX_PAYLOAD_BYTES} byte limit`,
      { bytes, limit: MAX_PAYLOAD_BYTES },
    );
  }
  return text;
}

export function decodePayload(text: string | null): Json | undefined {
  if (text === null) return undefined;
  return JSON.parse(text) as Json;
}

/** Small, log-safe description of a payload (design doc §15). */
export function summarizePayload(text: string | null): {
  type: string;
  bytes: number;
  hash: string | null;
} {
  if (text === null) return { type: "void", bytes: 0, hash: null };
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    return { type: "invalid", bytes: Buffer.byteLength(text, "utf8"), hash: null };
  }
  const type = parsed === null
    ? "null"
    : Array.isArray(parsed)
      ? "array"
      : typeof parsed;
  return {
    type,
    bytes: Buffer.byteLength(text, "utf8"),
    hash: fnv1a32(text),
  };
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
