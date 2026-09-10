import { shouldLog, type LogLevel, type Logger } from "./logger.ts";
import type { Json } from "./types.ts";

export interface TextLoggerOptions {
  level?: LogLevel;
  /** Human-readable diagnostics go to stdout unless the caller redirects them. */
  write?: (line: string) => void;
  base?: Record<string, Json>;
  now?: () => number;
}

/** Longest free-form text (plugin ids, failure messages) kept on a single line. */
const MAX_TEXT_LENGTH = 120;

type Fields = Record<string, Json>;

function text(value: Json | undefined, absent = "-"): string {
  if (value === undefined || value === null) return absent;
  const raw = typeof value === "string" ? value : String(value);
  const single = raw.replace(/\s+/gu, " ").trim();
  if (single.length === 0) return absent;
  return single.length > MAX_TEXT_LENGTH ? `${single.slice(0, MAX_TEXT_LENGTH - 1)}…` : single;
}

function count(value: Json | undefined): string {
  return typeof value === "number" ? String(value) : "?";
}

function clock(value: Json | undefined): string {
  if (typeof value === "number") return time(value);
  if (typeof value === "string") return text(value);
  return "-";
}

function time(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function attempt(fields: Fields): string {
  const current = count(fields.attempt);
  return fields.maxAttempts === undefined ? `attempt ${current}` : `attempt ${current}/${count(fields.maxAttempts)}`;
}

/** A child process reports either an exit code or the signal that killed it. */
function exit(fields: Fields): string[] {
  return [
    fields.exitCode === null || fields.exitCode === undefined ? null : `exit=${text(fields.exitCode)}`,
    fields.signal === null || fields.signal === undefined ? null : `signal=${text(fields.signal)}`,
    `終了=${text(fields.termination)}`,
  ].filter((part): part is string => part !== null);
}

/** A plugin id already prefixes the line, so name the workflow only when it does not. */
function origin(fields: Fields): string[] {
  return fields.pluginId === undefined ? [`workflow=${text(fields.workflow)}`] : [];
}

function step(fields: Fields): string {
  return `step ${text(fields.name)} (#${count(fields.seq)})`;
}

function details(parts: (string | null)[]): string {
  const kept = parts.filter((part): part is string => part !== null && part.length > 0);
  return kept.length === 0 ? "" : `（${kept.join("、")}）`;
}

const KINDS: Record<string, string> = {
  source: "source",
  event_consumer: "consumer",
  daily_consumer: "daily consumer",
};

function kind(fields: Fields): string {
  return KINDS[String(fields.kind)] ?? text(fields.kind, "plugin");
}

/**
 * One formatter per known event. Only the fields listed here reach the terminal,
 * so payloads, resolved secrets and journal results can never leak into the log.
 */
const MESSAGES: Record<string, (fields: Fields) => string> = {
  "plugin.discovered": (f) => `plugin を検出しました${details([`kind=${text(f.kind)}`])}`,
  "plugin.invalid": (f) => `plugin を読み込めません${details([`code=${text(f.code)}`])}`,
  "plugin.schedules_synced": (f) => `schedule を同期しました${details([
    `plugin ${count(f.plugins)} 件`, `作成 ${count(f.created)} 件`, `更新 ${count(f.updated)} 件`, `無効化 ${count(f.disabled)} 件`,
  ])}`,
  "plugin.invocation_started": (f) => `${kind(f)} を開始しました${details([f.invocationId === undefined ? null : `invocation=${text(f.invocationId)}`])}`,
  "plugin.invocation_completed": (f) => `${kind(f)} が完了しました${details([
    f.events === undefined ? null : `event ${count(f.events)} 件`,
    f.pages === undefined ? null : `page ${count(f.pages)} 件`,
  ])}`,
  "plugin.invocation_failed": (f) => `${kind(f)} が失敗しました${details([`code=${text(f.code)}`])}`,
  "plugin.process_spawned": (f) => `plugin 子プロセスを起動しました${details([`pid=${text(f.pid)}`])}`,
  "plugin.process_completed": (f) => `plugin 子プロセスが終了しました${details(exit(f))}`,
  "plugin.process_failed": (f) => `plugin 子プロセスが異常終了しました${details(exit(f))}`,
  "plugin.step_requested": (f) => `plugin が step を要求しました${details([text(f.name)])}`,
  "source.window": (f) => `取得 window を開きました${details([
    `${text(f.from)} 〜 ${text(f.to)}`, f.backfillLimited === true ? "backfill 上限で短縮" : null,
  ])}`,
  "source.page_started": (f) => `page ${count(f.page)} を取得します`,
  "source.page_completed": (f) => `page ${count(f.page)} を取得しました${details([
    `event ${count(f.events)} 件`, `保存 ${count(f.insertedEvents)} 件`,
    f.hasMore === true ? "続きあり" : "続きなし", f.cursorUpdated === true ? "cursor 更新" : null,
  ])}`,
  "source.events_saved": (f) => `event を ${count(f.events)} 件保存しました${details([`page ${count(f.pages)} 件`])}`,
  "consumer.events_processed": (f) => `event を ${count(f.events)} 件処理しました`,
  "consumer.event_started": (f) => `event の処理を開始しました${details([
    `event=${text(f.eventId)}`, `type=${text(f.eventType)}`, attempt(f),
  ])}`,
  "consumer.event_failed": (f) => `event の処理に失敗しました${details([
    `event=${text(f.eventId)}`, `type=${text(f.eventType)}`, attempt(f), `code=${text(f.code)}`,
  ])}`,
  "consumer.daily_window": (f) => `日次 window を決めました${details([
    `${text(f.from)} 〜 ${text(f.to)}`, `slot=${text(f.scheduledAt)}`,
  ])}`,
  "consumer.history_queried": (f) => `履歴を照会しました${details([
    `${text(f.from)} 〜 ${text(f.to)}`, `event ${count(f.events)} 件`, f.hasMore === true ? "続きあり" : "続きなし",
  ])}`,
  "step.started": (f) => `${step(f)} を開始しました${details([f.attempt === 0 ? null : attempt(f)])}`,
  "step.completed": (f) => `${step(f)} が完了しました${details([`${count(f.durationMs)}ms`])}`,
  "step.replayed": (f) => `${step(f)} を journal から再生しました${details([f.attempt === 0 ? null : attempt(f)])}`,
  "step.failed": (f) => `${step(f)} が失敗しました${details([
    attempt(f), f.exhausted === true ? "retry 上限" : null, f.terminal === true ? "terminal" : null, text(f.message),
  ])}`,
  "step.retry_scheduled": (f) => `${step(f)} の retry を予約しました${details([
    attempt(f), `${count(f.delayMs)}ms 後`, `再開 ${clock(f.availableAt)}`,
  ])}`,
  "sleep.started": (f) => `sleep ${text(f.name)} を開始しました${details([`再開 ${clock(f.wakeAt)}`])}`,
  "sleep.completed": (f) => `sleep ${text(f.name)} が明けました`,
  "invocation.enqueued": (f) => `invocation を登録しました${details([`workflow=${text(f.workflow)}`, `invocation=${text(f.invocationId)}`])}`,
  "invocation.started": (f) => `invocation を開始しました${details([`workflow=${text(f.workflow)}`, `invocation=${text(f.invocationId)}`])}`,
  "invocation.completed": (f) => `invocation が完了しました${details([...origin(f), `${count(f.durationMs)}ms`])}`,
  "invocation.suspended": (f) => `invocation を中断しました${details([...origin(f), `状態=${text(f.status)}`, `再開 ${clock(f.availableAt)}`])}`,
  "invocation.cancelled": (f) => `invocation をキャンセルしました${details(origin(f))}`,
  "invocation.failed": (f) => `invocation が失敗しました${details([
    ...origin(f), f.code === null || f.code === undefined ? null : `code=${text(f.code)}`,
    `${text(f.errorName)}: ${text(f.message)}`,
  ])}`,
  "invocation.retry_requested": (f) => `invocation の再試行を受け付けました${details([`invocation=${text(f.invocationId)}`])}`,
  "invocation.unknown_workflow": (f) => `workflow が登録されていません${details([`workflow=${text(f.workflow)}`, `invocation=${text(f.id)}`])}`,
  "invocation.version_mismatch": (f) => `workflow の version が一致しません${details([
    `workflow=${text(f.workflow)}`, `invocation=${text(f.invocationVersion)}`, `登録=${text(f.registeredVersion)}`,
  ])}`,
  "schedule.created": (f) => `schedule を作成しました${details([
    `schedule=${text(f.scheduleId)}`, `workflow=${text(f.workflow)}`, `次回 ${clock(f.nextRunAt)}`,
  ])}`,
  "schedule.deleted": (f) => `schedule を削除しました${details([`schedule=${text(f.scheduleId)}`])}`,
  "schedule.materialized": (f) => `schedule から invocation を ${count(f.created)} 件生成しました${details([
    `schedule=${text(f.scheduleId)}`, `次回 ${clock(f.nextRunAt)}`,
    f.dropped === 0 ? null : `破棄 ${count(f.dropped)} 件`, f.deferred === 0 ? null : `繰り延べ ${count(f.deferred)} 件`,
  ])}`,
  "schedule.unknown_workflow": (f) => `schedule の workflow が登録されていません${details([
    `schedule=${text(f.scheduleId)}`, `workflow=${text(f.workflow)}`,
  ])}`,
  "tick.lease_lost": () => "別の runner が実行を引き継いだため tick を中断しました",
  "lease.lost": (f) => `lease を失いました${details([`lease=${text(f.lease)}`])}`,
  "tick.finished": (f) => f.skipped === true
    ? "tick を見送りました（別の runner が実行中）"
    : `tick を終了しました${details([
      `実行 ${count(f.runs)} 件`, `生成 ${count(f.materialized)} 件`,
      f.recovered === 0 ? null : `復旧 ${count(f.recovered)} 件`, f.woken === 0 ? null : `再開 ${count(f.woken)} 件`,
    ])}`,
};

/** The line prefix that tells concurrent plugins apart. */
function subject(fields: Fields): string | null {
  const pluginId = fields.pluginId;
  return typeof pluginId === "string" && pluginId.length > 0 ? text(pluginId) : null;
}

/** Unknown events still have to be readable, so render their scalar fields only. */
function fallback(event: string, fields: Fields): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "pluginId") continue;
    if (typeof value === "object" && value !== null) continue;
    parts.push(`${key}=${text(value, "null")}`);
  }
  return `${event}${details(parts)}`;
}

/**
 * Lines the caller already reports itself: a plugin invocation logs its own start
 * and finish, and a tick is summarized by the command that ran it. Keeping the
 * runtime's copy for `--debug` avoids printing every moment twice.
 */
function echoesCallerLine(event: string, fields: Fields): boolean {
  if (event === "tick.finished") return true;
  return fields.pluginId !== undefined && (event === "invocation.started" || event === "invocation.completed");
}

const LEVEL_PREFIX: Record<LogLevel, string> = { debug: "", info: "", warn: "警告: ", error: "エラー: " };

export function formatLogLine(level: LogLevel, event: string, fields: Fields, at: number): string {
  const message = MESSAGES[event]?.(fields) ?? fallback(event, fields);
  const owner = subject(fields);
  return `[${time(at)}] ${LEVEL_PREFIX[level]}${owner === null ? "" : `${owner} `}${message}`;
}

/**
 * Writes one short line per event so a `tick` can be followed in a terminal.
 * `JsonLogger` stays the machine-readable form used by `--json`.
 */
export class TextLogger implements Logger {
  #level: LogLevel;
  #write: (line: string) => void;
  #base: Record<string, Json>;
  #now: () => number;

  constructor(options: TextLoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.#base = options.base ?? {};
    this.#now = options.now ?? Date.now;
  }

  log(level: LogLevel, event: string, fields: Record<string, Json> = {}): void {
    if (!shouldLog(level, this.#level)) return;
    const fieldsWithBase = { ...this.#base, ...fields };
    if (this.#level !== "debug" && echoesCallerLine(event, fieldsWithBase)) return;
    const line = formatLogLine(level, event, fieldsWithBase, this.#now());
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
    return new TextLogger({
      level: this.#level,
      write: this.#write,
      base: { ...this.#base, ...fields },
      now: this.#now,
    });
  }
}
