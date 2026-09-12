import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { formatDuration, parseDuration } from "../core/duration.ts";
import {
  ExitCode,
  DuexError,
  UsageError,
  exitCodeOf,
} from "../core/errors.ts";
import { JsonLogger, silentLogger } from "../core/logger.ts";
import { createRuntime, loadConfig } from "../config.ts";
import { invocationView, journalView, scheduleView } from "../core/views.ts";
import { startHttpServer } from "./http.ts";
import type { ExitCodeValue } from "../core/errors.ts";
import type { LogLevel } from "../core/logger.ts";
import type { RuntimeApi } from "../core/runtime-api.ts";
import type { CatchUpPolicy, InvocationStatus, Json } from "../core/types.ts";

/**
 * CLI ingress adapter.
 *
 * A first-class front door alongside the HTTP API. It parses arguments, prints
 * human or JSON output and maps errors to exit codes — nothing else
 * (design doc D2).
 */

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const OPTIONS = {
  config: { type: "string", short: "c" },
  db: { type: "string" },
  json: { type: "boolean", default: false },
  "log-level": { type: "string" },
  quiet: { type: "boolean", default: false },
  input: { type: "string" },
  "idempotency-key": { type: "string" },
  wait: { type: "boolean", default: false },
  detach: { type: "boolean", default: false },
  timeout: { type: "string" },
  "max-runs": { type: "string" },
  "no-schedules": { type: "boolean", default: false },
  status: { type: "string", multiple: true },
  workflow: { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
  every: { type: "string" },
  "catch-up": { type: "string" },
  "max-catch-up": { type: "string" },
  "start-at": { type: "string" },
  disabled: { type: "boolean", default: false },
  host: { type: "string" },
  port: { type: "string" },
  poll: { type: "string" },
  id: { type: "string" },
  out: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", default: false },
} as const;

type CliValues = Record<string, string | string[] | boolean | undefined>;

const VERSION = "0.1.0";

const USAGE = `duex ${VERSION} — a local durable workflow runtime

Usage: duex <command> [options]

Commands
  init                            create the database and run migrations
  workflows list                  list registered workflows
  invoke <workflow>               start a workflow
  tick                            process due work once, then exit
  invocations list                list invocations
  invocations show <id>           show one invocation
  invocations retry <id>          re-queue a failed invocation
  invocations cancel <id>         cancel a pending/sleeping/retry_wait invocation
  journal show <id>               show the ordered journal of an invocation
  schedules create <id>           create a fixed-interval schedule
  schedules list                  list schedules
  schedules show <id>             show one schedule
  schedules enable|disable <id>   toggle a schedule
  schedules delete <id>           delete a schedule
  serve                           start the HTTP adapter and a runner loop
  doctor                          check schema, integrity, leases and versions
  export                          dump invocations and journals as JSON

Global options
  -c, --config <path>   config file (default: nearest duex.config.ts)
      --db <path>       override the SQLite file
      --json            machine-readable output on stdout
      --log-level <l>   debug | info | warn | error
      --quiet           suppress diagnostics on stderr
  -h, --help            show this help

Examples
  duex invoke fishing-advisor --input @input.json --wait
  duex invoke fishing-advisor --input '{"location":"Hakata Bay"}' \\
    --idempotency-key fishing-2026-08-31T10 --detach
  duex tick --max-runs 20
  duex schedules create hourly-fishing-advisor --workflow fishing-advisor \\
    --every 1h --input @config/fishing-input.json --catch-up latest
  duex serve --host 127.0.0.1 --port 8080

Exit codes
  0 success (also: enqueued, or another runner is active)
  2 usage or input validation error
  3 workflow terminal failure
  4 config / schema / version mismatch
  5 internal runtime or storage error
`;

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo,
): Promise<ExitCodeValue> {
  let values: CliValues;
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args: argv,
      options: OPTIONS as never,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as CliValues;
    positionals = parsed.positionals;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr(USAGE);
    return ExitCode.USAGE;
  }

  if (values.version === true) {
    io.stdout(`${VERSION}\n`);
    return ExitCode.OK;
  }
  if (positionals.length === 0 || values.help === true) {
    io.stdout(USAGE);
    return positionals.length === 0 && values.help !== true
      ? ExitCode.USAGE
      : ExitCode.OK;
  }

  const command = positionals[0];
  const rest = positionals.slice(1);

  try {
    return await dispatch(command, rest, values, io);
  } catch (error) {
    return reportError(error, values, io);
  }
}

async function dispatch(
  command: string,
  rest: string[],
  values: CliValues,
  io: CliIo,
): Promise<ExitCodeValue> {
  switch (command) {
    case "help":
      io.stdout(USAGE);
      return ExitCode.OK;
    case "init":
      return withRuntime(values, io, (runtime) => commandInit(runtime, values, io));
    case "workflows":
      return withRuntime(values, io, (runtime) =>
        commandWorkflows(runtime, rest, values, io),
      );
    case "invoke":
      return withRuntime(values, io, (runtime) =>
        commandInvoke(runtime, rest, values, io),
      );
    case "tick":
      return withRuntime(values, io, (runtime) => commandTick(runtime, values, io));
    case "invocations":
      return withRuntime(values, io, (runtime) =>
        commandInvocations(runtime, rest, values, io),
      );
    case "journal":
      return withRuntime(values, io, (runtime) =>
        commandJournal(runtime, rest, values, io),
      );
    case "schedules":
      return withRuntime(values, io, (runtime) =>
        commandSchedules(runtime, rest, values, io),
      );
    case "doctor":
      return withRuntime(values, io, (runtime) => commandDoctor(runtime, values, io));
    case "export":
      return withRuntime(values, io, (runtime) => commandExport(runtime, values, io));
    case "serve":
      return commandServe(values, io);
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
}

// ----------------------------------------------------------------- commands

function commandInit(runtime: RuntimeApi, values: CliValues, io: CliIo): ExitCodeValue {
  const result = runtime.init();
  emit(values, io, result as unknown as Json, () =>
    `initialized ${runtime.store.driver} store (schema v${result.schemaVersion})\n`,
  );
  return ExitCode.OK;
}

function commandWorkflows(
  runtime: RuntimeApi,
  rest: string[],
  values: CliValues,
  io: CliIo,
): ExitCodeValue {
  const sub = rest[0] ?? "list";
  if (sub !== "list") throw new UsageError(`unknown subcommand: workflows ${sub}`);
  const workflows = runtime.workflows();
  emit(values, io, { workflows } as unknown as Json, () =>
    workflows.length === 0
      ? "no workflows registered\n"
      : `${table(
          ["NAME", "VERSION"],
          workflows.map((workflow) => [workflow.name, workflow.version]),
        )}\n`,
  );
  return ExitCode.OK;
}

async function commandInvoke(
  runtime: RuntimeApi,
  rest: string[],
  values: CliValues,
  io: CliIo,
): Promise<ExitCodeValue> {
  const workflow = rest[0];
  if (!workflow) throw new UsageError("invoke requires a workflow name");
  if (values.wait === true && values.detach === true) {
    throw new UsageError("--wait and --detach are mutually exclusive");
  }

  const result = await runtime.invoke({
    workflow,
    input: readInput(values),
    idempotencyKey: optionalString(values, "idempotency-key") ?? null,
    wait: values.wait === true,
    waitTimeoutMs: values.timeout
      ? parseDuration(String(values.timeout))
      : undefined,
  });

  const view = invocationView(result.invocation);
  emit(
    values,
    io,
    {
      ...(view as unknown as Record<string, Json>),
      created: result.created,
      ran: result.ran,
      outcome: result.outcome ?? null,
    } as unknown as Json,
    () => {
      const lines = [
        `${result.created ? "created" : "reused"} invocation ${view.id}`,
        `workflow: ${view.workflow}@${view.workflowVersion}`,
        `status:   ${view.status}`,
      ];
      if (view.status === "completed" && view.hasOutput) {
        lines.push(`output:   ${JSON.stringify(view.output)}`);
      }
      if (view.error) {
        lines.push(`error:    ${formatError(view.error)}`);
        lines.push(`          run \`duex journal show ${view.id}\` for details`);
      }
      if (view.status === "sleeping" || view.status === "retry_wait") {
        lines.push(`due at:   ${view.availableAt}`);
      }
      return `${lines.join("\n")}\n`;
    },
  );

  return result.invocation.status === "failed"
    ? ExitCode.WORKFLOW_FAILURE
    : ExitCode.OK;
}

async function commandTick(
  runtime: RuntimeApi,
  values: CliValues,
  io: CliIo,
): Promise<ExitCodeValue> {
  const result = await runtime.tick({
    maxRuns: values["max-runs"] ? intOption(values, "max-runs") : undefined,
    schedules: values["no-schedules"] !== true,
  });

  emit(values, io, result as unknown as Json, () => {
    if (result.skipped) {
      return `skipped: ${result.reason ?? "another runner is active"}${
        result.owner ? ` (owner ${result.owner})` : ""
      }\n`;
    }
    const lines = [
      `materialized ${result.materialized.reduce(
        (total, schedule) => total + schedule.created.length,
        0,
      )} scheduled invocation(s) from ${result.materialized.length} schedule(s)`,
      `recovered ${result.recovered}, woke ${result.woken}, ran ${result.runs.length}`,
    ];
    for (const run of result.runs) {
      lines.push(
        `  ${run.id}  ${run.workflow}  ${run.outcome}  ${formatDuration(run.durationMs)}${
          run.reason ? `  (${run.reason})` : ""
        }`,
      );
    }
    return `${lines.join("\n")}\n`;
  });

  const failed = result.runs.some((run) => run.outcome === "failed");
  return failed ? ExitCode.WORKFLOW_FAILURE : ExitCode.OK;
}

function commandInvocations(
  runtime: RuntimeApi,
  rest: string[],
  values: CliValues,
  io: CliIo,
): ExitCodeValue {
  const sub = rest[0] ?? "list";

  if (sub === "list") {
    const statuses = (values.status as string[] | undefined) ?? [];
    const invocations = runtime.listInvocations({
      status: statuses.length > 0 ? (statuses as InvocationStatus[]) : undefined,
      workflowName: optionalString(values, "workflow"),
      limit: values.limit ? intOption(values, "limit") : 50,
      offset: values.offset ? intOption(values, "offset") : 0,
    });
    const views = invocations.map(invocationView);
    emit(values, io, { invocations: views } as unknown as Json, () =>
      views.length === 0
        ? "no invocations\n"
        : `${table(
            ["ID", "WORKFLOW", "STATUS", "AVAILABLE AT", "UPDATED AT"],
            views.map((view) => [
              view.id,
              `${view.workflow}@${view.workflowVersion}`,
              view.status,
              view.availableAt,
              view.updatedAt,
            ]),
          )}\n`,
    );
    return ExitCode.OK;
  }

  const id = rest[1];
  if (!id) throw new UsageError(`invocations ${sub} requires an invocation id`);

  if (sub === "show") {
    const view = invocationView(runtime.getInvocation(id));
    emit(values, io, view as unknown as Json, () => describeInvocation(view));
    return view.status === "failed" ? ExitCode.WORKFLOW_FAILURE : ExitCode.OK;
  }
  if (sub === "retry") {
    const view = invocationView(runtime.retryInvocation(id));
    emit(values, io, view as unknown as Json, () =>
      `invocation ${view.id} re-queued (status ${view.status})\n`,
    );
    return ExitCode.OK;
  }
  if (sub === "cancel") {
    const view = invocationView(runtime.cancelInvocation(id));
    emit(values, io, view as unknown as Json, () =>
      `invocation ${view.id} cancelled\n`,
    );
    return ExitCode.OK;
  }
  throw new UsageError(`unknown subcommand: invocations ${sub}`);
}

function commandJournal(
  runtime: RuntimeApi,
  rest: string[],
  values: CliValues,
  io: CliIo,
): ExitCodeValue {
  const sub = rest[0];
  if (sub !== "show") throw new UsageError(`unknown subcommand: journal ${sub ?? ""}`);
  const id = rest[1];
  if (!id) throw new UsageError("journal show requires an invocation id");

  const entries = runtime.getJournal(id).map(journalView);
  emit(
    values,
    io,
    { invocationId: id, journal: entries } as unknown as Json,
    () =>
      entries.length === 0
        ? "journal is empty\n"
        : `${table(
            ["SEQ", "KIND", "NAME", "STATUS", "ATTEMPT", "DURATION", "RESULT"],
            entries.map((entry) => [
              String(entry.seq),
              entry.kind,
              entry.name,
              entry.status,
              String(entry.attempt),
              entry.durationMs === null ? "-" : formatDuration(entry.durationMs),
              entry.error
                ? `error: ${(entry.error as { message?: string }).message ?? ""}`
                : entry.hasOutput
                  ? truncate(JSON.stringify(entry.output), 48)
                  : "-",
            ]),
          )}\n`,
  );
  return ExitCode.OK;
}

function commandSchedules(
  runtime: RuntimeApi,
  rest: string[],
  values: CliValues,
  io: CliIo,
): ExitCodeValue {
  const sub = rest[0] ?? "list";

  if (sub === "list") {
    const schedules = runtime.listSchedules().map(scheduleView);
    emit(values, io, { schedules } as unknown as Json, () =>
      schedules.length === 0
        ? "no schedules\n"
        : `${table(
            ["ID", "WORKFLOW", "EVERY", "NEXT RUN", "CATCH-UP", "ENABLED"],
            schedules.map((schedule) => [
              schedule.id,
              schedule.workflow,
              formatDuration(schedule.everyMs),
              schedule.nextRunAt,
              schedule.catchUp,
              schedule.enabled ? "yes" : "no",
            ]),
          )}\n`,
    );
    return ExitCode.OK;
  }

  const id = rest[1];
  if (!id) throw new UsageError(`schedules ${sub} requires a schedule id`);

  if (sub === "create") {
    const workflow = optionalString(values, "workflow");
    if (!workflow) throw new UsageError("schedules create requires --workflow");
    const every = optionalString(values, "every");
    if (!every) throw new UsageError("schedules create requires --every");

    const startAtRaw = optionalString(values, "start-at");
    const startAt = startAtRaw ? parseInstant(startAtRaw) : undefined;

    const schedule = scheduleView(
      runtime.createSchedule({
        id,
        workflow,
        input: readInput(values),
        every,
        catchUp: optionalString(values, "catch-up") as CatchUpPolicy | undefined,
        maxCatchUp: values["max-catch-up"] ? intOption(values, "max-catch-up") : undefined,
        startAt,
        enabled: values.disabled !== true,
      }),
    );
    emit(values, io, schedule as unknown as Json, () =>
      `created schedule ${schedule.id} (${schedule.workflow} every ${formatDuration(
        schedule.everyMs,
      )}, next run ${schedule.nextRunAt})\n`,
    );
    return ExitCode.OK;
  }
  if (sub === "show") {
    const schedule = scheduleView(runtime.getSchedule(id));
    emit(values, io, schedule as unknown as Json, () =>
      describeRecord(schedule as unknown as Record<string, unknown>),
    );
    return ExitCode.OK;
  }
  if (sub === "enable" || sub === "disable") {
    const schedule = scheduleView(runtime.setScheduleEnabled(id, sub === "enable"));
    emit(values, io, schedule as unknown as Json, () =>
      `schedule ${schedule.id} ${sub}d\n`,
    );
    return ExitCode.OK;
  }
  if (sub === "delete") {
    runtime.deleteSchedule(id);
    emit(values, io, { deleted: id }, () => `schedule ${id} deleted\n`);
    return ExitCode.OK;
  }
  throw new UsageError(`unknown subcommand: schedules ${sub}`);
}

function commandDoctor(
  runtime: RuntimeApi,
  values: CliValues,
  io: CliIo,
): ExitCodeValue {
  const report = runtime.doctor();
  emit(values, io, report as unknown as Json, () => {
    const lines = [
      `driver:         ${report.driver}`,
      `schema version: ${report.schemaVersion}`,
      `integrity:      ${report.integrity.join(", ")}`,
      `workflows:      ${
        report.registeredWorkflows
          .map((workflow) => `${workflow.name}@${workflow.version}`)
          .join(", ") || "(none)"
      }`,
      `invocations:    ${
        Object.entries(report.invocationCounts)
          .map(([status, count]) => `${status}=${count}`)
          .join(" ") || "(none)"
      }`,
      `runner lease:   ${
        report.lease
          ? `${report.lease.ownerId} (${report.lease.stale ? "stale" : "live"})`
          : "(free)"
      }`,
    ];
    for (const problem of report.problems) {
      lines.push(`problem [${problem.kind}]: ${problem.message}`);
    }
    lines.push(report.ok ? "status: ok" : "status: problems found");
    return `${lines.join("\n")}\n`;
  });
  return report.ok ? ExitCode.OK : ExitCode.CONFIG;
}

function commandExport(
  runtime: RuntimeApi,
  values: CliValues,
  io: CliIo,
): ExitCodeValue {
  const dump = runtime.exportInvocations({
    id: optionalString(values, "id"),
    limit: values.limit ? intOption(values, "limit") : undefined,
  });
  const payload = {
    exportedAt: new Date(dump.exportedAt).toISOString(),
    invocations: dump.invocations.map((invocation) => ({
      ...(invocationView(invocation) as unknown as Record<string, Json>),
      journal: invocation.journal.map(journalView),
    })),
  } as unknown as Json;

  const out = optionalString(values, "out");
  if (out) {
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    emit(values, io, { written: out, count: dump.invocations.length }, () =>
      `exported ${dump.invocations.length} invocation(s) to ${out}\n`,
    );
    return ExitCode.OK;
  }
  io.stdout(`${JSON.stringify(payload, null, values.json === true ? 0 : 2)}\n`);
  return ExitCode.OK;
}

async function commandServe(values: CliValues, io: CliIo): Promise<ExitCodeValue> {
  const loaded = await loadConfig({
    path: optionalString(values, "config"),
    dbPath: optionalString(values, "db"),
  });
  const logger = buildLogger(values, loaded.config.logLevel);
  const runtime = createRuntime(loaded, { logger });

  const host = optionalString(values, "host") ?? loaded.config.http?.host ?? "127.0.0.1";
  const port = values.port ? intOption(values, "port") : (loaded.config.http?.port ?? 8080);
  const pollIntervalMs = values.poll
    ? parseDuration(String(values.poll))
    : (loaded.config.http?.pollIntervalMs ?? 1000);

  const started = await startHttpServer({
    runtime,
    logger,
    host,
    port,
    pollIntervalMs,
    maxRunsPerPoll: loaded.config.runner?.maxRuns ?? 20,
  });

  if (host === "0.0.0.0" || host === "::") {
    io.stderr(
      `warning: binding to ${host} exposes duex to the network and ` +
        `there is no authentication\n`,
    );
  }
  io.stderr(
    `duex serving on ${started.url} (db ${loaded.dbPath}, ` +
      `runner poll ${pollIntervalMs === 0 ? "off" : formatDuration(pollIntervalMs)})\n`,
  );

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      io.stderr("shutting down\n");
      void started.close().then(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  runtime.close();
  return ExitCode.OK;
}

// ------------------------------------------------------------------ helpers

async function withRuntime(
  values: CliValues,
  io: CliIo,
  fn: (runtime: RuntimeApi) => ExitCodeValue | Promise<ExitCodeValue>,
): Promise<ExitCodeValue> {
  const loaded = await loadConfig({
    path: optionalString(values, "config"),
    dbPath: optionalString(values, "db"),
  });
  const runtime = createRuntime(loaded, { logger: buildLogger(values, loaded.config.logLevel) });
  try {
    return await fn(runtime);
  } finally {
    runtime.close();
  }
}

function buildLogger(values: CliValues, configLevel: LogLevel | undefined) {
  if (values.quiet === true) return silentLogger;
  const level = (optionalString(values, "log-level") as LogLevel | undefined) ??
    configLevel ??
    "info";
  return new JsonLogger({ level, write: (line) => process.stderr.write(`${line}\n`) });
}

function reportError(error: unknown, values: CliValues, io: CliIo): ExitCodeValue {
  const code = exitCodeOf(error);
  if (values.json === true) {
    const detail =
      error instanceof DuexError
        ? { code: error.code, message: error.message, detail: error.detail ?? null }
        : {
            code: "INTERNAL",
            message: error instanceof Error ? error.message : String(error),
            detail: null,
          };
    io.stdout(`${JSON.stringify({ error: detail })}\n`);
  } else {
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    if (!(error instanceof DuexError) && error instanceof Error && error.stack) {
      io.stderr(`${error.stack}\n`);
    }
  }
  return code;
}

function emit(
  values: CliValues,
  io: CliIo,
  json: Json,
  human: () => string,
): void {
  if (values.json === true) {
    io.stdout(`${JSON.stringify(json)}\n`);
    return;
  }
  io.stdout(human());
}

function optionalString(values: CliValues, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function intOption(values: CliValues, key: string): number {
  const raw = optionalString(values, key);
  if (raw === undefined) throw new UsageError(`--${key} requires a value`);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new UsageError(`--${key} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function parseInstant(raw: string): number {
  if (/^\d+$/u.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new UsageError(
      `invalid instant ${JSON.stringify(raw)}; use epoch milliseconds or an ISO-8601 timestamp`,
    );
  }
  return parsed;
}

/** `--input @file`, `--input -` (stdin) or an inline JSON document. */
function readInput(values: CliValues): Json {
  const raw = optionalString(values, "input");
  if (raw === undefined) return null;

  let text = raw;
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    try {
      text = readFileSync(path === "-" ? 0 : path, "utf8");
    } catch (error) {
      throw new UsageError(
        `cannot read --input ${JSON.stringify(path)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else if (raw === "-") {
    text = readFileSync(0, "utf8");
  }

  try {
    return JSON.parse(text) as Json;
  } catch (error) {
    throw new UsageError(
      `--input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function describeInvocation(view: ReturnType<typeof invocationView>): string {
  const lines = [
    `id:         ${view.id}`,
    `workflow:   ${view.workflow}@${view.workflowVersion}`,
    `status:     ${view.status}`,
    `available:  ${view.availableAt}`,
    `created:    ${view.createdAt}`,
    `updated:    ${view.updatedAt}`,
  ];
  if (view.idempotencyKey) lines.push(`idempotency: ${view.idempotencyKey}`);
  if (view.scheduleId) {
    lines.push(`schedule:   ${view.scheduleId} @ ${view.scheduledAt}`);
  }
  lines.push(`input:      ${truncate(JSON.stringify(view.input), 200)}`);
  if (view.hasOutput) {
    lines.push(`output:     ${truncate(JSON.stringify(view.output), 200)}`);
  }
  if (view.error) {
    lines.push(`error:      ${formatError(view.error)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Human-readable one-liner; the full payload (including stack) stays in --json. */
function formatError(error: Json): string {
  const detail = error as { name?: string; message?: string; code?: string };
  const code = detail.code ? ` [${detail.code}]` : "";
  return `${detail.name ?? "Error"}${code}: ${truncate(detail.message ?? "", 200)}`;
}

function describeRecord(record: Record<string, unknown>): string {
  const width = Math.max(...Object.keys(record).map((key) => key.length));
  return `${Object.entries(record)
    .map(([key, value]) => `${key.padEnd(width)}  ${
      typeof value === "string" ? value : JSON.stringify(value)
    }`)
    .join("\n")}\n`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const render = (cells: string[]) =>
    cells.map((cell, index) => (cell ?? "").padEnd(widths[index])).join("  ").trimEnd();
  return [render(headers), ...rows.map(render)].join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
