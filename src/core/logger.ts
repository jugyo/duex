import type { Json } from "./types.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, Json>): void;
  debug(event: string, fields?: Record<string, Json>): void;
  info(event: string, fields?: Record<string, Json>): void;
  warn(event: string, fields?: Record<string, Json>): void;
  error(event: string, fields?: Record<string, Json>): void;
  child(fields: Record<string, Json>): Logger;
}

export interface JsonLoggerOptions {
  level?: LogLevel;
  /** Diagnostics always go to stderr so `--json` stdout stays machine-readable. */
  write?: (line: string) => void;
  base?: Record<string, Json>;
  now?: () => number;
}

export class JsonLogger implements Logger {
  #level: LogLevel;
  #write: (line: string) => void;
  #base: Record<string, Json>;
  #now: () => number;

  constructor(options: JsonLoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
    this.#base = options.base ?? {};
    this.#now = options.now ?? Date.now;
  }

  log(level: LogLevel, event: string, fields: Record<string, Json> = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) return;
    const line = JSON.stringify({
      ts: new Date(this.#now()).toISOString(),
      level,
      event,
      ...this.#base,
      ...fields,
    });
    try { this.#write(line); } catch { /* Logging must never change workflow results. */ }
  }

  debug(event: string, fields?: Record<string, Json>): void {
    this.log("debug", event, fields);
  }
  info(event: string, fields?: Record<string, Json>): void {
    this.log("info", event, fields);
  }
  warn(event: string, fields?: Record<string, Json>): void {
    this.log("warn", event, fields);
  }
  error(event: string, fields?: Record<string, Json>): void {
    this.log("error", event, fields);
  }

  child(fields: Record<string, Json>): Logger {
    return new JsonLogger({
      level: this.#level,
      write: this.#write,
      base: { ...this.#base, ...fields },
      now: this.#now,
    });
  }
}

export const silentLogger: Logger = {
  log() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
