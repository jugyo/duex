import type { InvocationStatus, Json, SerializedError } from "./types.ts";

/**
 * Exit codes are part of the CLI contract (design doc §11) and are attached to
 * every runtime error so adapters never have to re-classify failures.
 */
export const ExitCode = {
  OK: 0,
  USAGE: 2,
  WORKFLOW_FAILURE: 3,
  CONFIG: 4,
  INTERNAL: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class DuexError extends Error {
  readonly code: string;
  readonly exitCode: ExitCodeValue;
  readonly detail: Json | undefined;

  constructor(
    message: string,
    options: {
      code?: string;
      exitCode?: ExitCodeValue;
      detail?: Json;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? "DUEX_ERROR";
    this.exitCode = options.exitCode ?? ExitCode.INTERNAL;
    this.detail = options.detail;
  }
}

/** Bad CLI/HTTP input. */
export class UsageError extends DuexError {
  constructor(message: string, detail?: Json) {
    super(message, { code: "USAGE", exitCode: ExitCode.USAGE, detail });
  }
}

/** Config, registry or workflow-version problems. */
export class ConfigError extends DuexError {
  constructor(message: string, detail?: Json) {
    super(message, { code: "CONFIG", exitCode: ExitCode.CONFIG, detail });
  }
}

/** The requested transition is not legal from the current status. */
export class ConflictError extends DuexError {
  constructor(message: string, detail?: Json) {
    super(message, { code: "CONFLICT", exitCode: ExitCode.USAGE, detail });
  }
}

export class NotFoundError extends DuexError {
  constructor(message: string, detail?: Json) {
    super(message, { code: "NOT_FOUND", exitCode: ExitCode.USAGE, detail });
  }
}

/**
 * Thrown by workflow code to fail an invocation immediately, without consuming
 * further retry attempts.
 */
export class TerminalError extends DuexError {
  constructor(message: string, detail?: Json) {
    super(message, {
      code: "TERMINAL",
      exitCode: ExitCode.WORKFLOW_FAILURE,
      detail,
    });
  }
}

/**
 * The journal no longer matches the code: an operation was inserted, removed or
 * reordered, or two durable operations ran concurrently.
 */
export class NonDeterministicWorkflowError extends DuexError {
  constructor(message: string, detail?: Json) {
    super(message, {
      code: "NON_DETERMINISTIC",
      exitCode: ExitCode.CONFIG,
      detail,
    });
  }
}

/** A value that cannot cross the durability boundary. */
export class SerializationError extends DuexError {
  constructor(message: string, detail?: Json) {
    super(message, { code: "SERIALIZATION", exitCode: ExitCode.CONFIG, detail });
  }
}

/** Raised at an operation boundary when the invocation was cancelled. */
export class InvocationCancelledError extends DuexError {
  constructor(invocationId: string) {
    super(`invocation ${invocationId} was cancelled`, {
      code: "CANCELLED",
      exitCode: ExitCode.OK,
    });
  }
}

/**
 * Internal control-flow signal: the handler cannot make progress right now.
 * Never surfaces to workflow authors or adapters.
 */
export class SuspendInvocation extends Error {
  readonly status: Extract<InvocationStatus, "sleeping" | "retry_wait">;
  readonly availableAt: number;
  readonly seq: number;

  constructor(
    status: Extract<InvocationStatus, "sleeping" | "retry_wait">,
    availableAt: number,
    seq: number,
  ) {
    super(`invocation suspended (${status}) until ${availableAt}`);
    this.name = "SuspendInvocation";
    this.status = status;
    this.availableAt = availableAt;
    this.seq = seq;
  }
}

export function isTerminalError(error: unknown): boolean {
  return (
    error instanceof TerminalError ||
    error instanceof NonDeterministicWorkflowError ||
    error instanceof SerializationError ||
    (error instanceof Error && (error as { terminal?: boolean }).terminal === true)
  );
}

/** Convert a thrown value into the JSON shape stored in `error_json`. */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof DuexError) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
      terminal: isTerminalError(error),
      code: error.code,
    };
    if (error.stack) serialized.stack = error.stack;
    if (error.detail !== undefined) serialized.detail = error.detail;
    return serialized;
  }
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
      terminal: isTerminalError(error),
    };
    if (error.stack) serialized.stack = error.stack;
    return serialized;
  }
  return {
    name: "UnknownError",
    message: String(error),
    terminal: false,
  };
}

/** Rebuild a throwable from a stored `error_json` payload. */
export function deserializeError(serialized: SerializedError): Error {
  const error = serialized.terminal
    ? new TerminalError(serialized.message, serialized.detail)
    : new DuexError(serialized.message, {
        code: serialized.code,
        detail: serialized.detail,
      });
  error.name = serialized.name;
  if (serialized.stack) error.stack = serialized.stack;
  return error;
}

export function exitCodeOf(error: unknown): ExitCodeValue {
  if (error instanceof DuexError) return error.exitCode;
  return ExitCode.INTERNAL;
}
