import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";

import { loadConfig, createRuntime } from "../src/config.ts";
import { runCli } from "../src/adapters/cli.ts";
import { startHttpServer } from "../src/adapters/http.ts";
import { silentLogger } from "../src/core/logger.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RuntimeApi } from "../src/core/runtime-api.ts";
import type { StartedHttpServer } from "../src/adapters/http.ts";

/**
 * CLI and HTTP are both first-class ingress adapters: an invocation created
 * through one is fully observable and operable through the other, and both
 * return the same view objects (design doc D2, §17 Phase 6).
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = join(ROOT, "examples", "basic", "duex.config.ts");

let directory: string;
let dbPath: string;
let runtime: RuntimeApi;
let server: StartedHttpServer;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "duex-parity-"));
  dbPath = join(directory, "state.sqlite");
  const loaded = await loadConfig({ path: CONFIG, dbPath });
  runtime = createRuntime(loaded, { logger: silentLogger });
  server = await startHttpServer({
    runtime,
    logger: silentLogger,
    host: "127.0.0.1",
    port: 0,
    pollIntervalMs: 0,
  });
});

after(async () => {
  await server.close();
  runtime.close();
  rmSync(directory, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(...args: string[]): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...args, "--config", CONFIG, "--db", dbPath, "--quiet"], {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

async function cliJson<T>(...args: string[]): Promise<T> {
  const result = await cli(...args, "--json");
  return JSON.parse(result.stdout.trim()) as T;
}

async function http<T>(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/** Fields added by an adapter on top of the shared view. */
function core(view: Record<string, unknown>): Record<string, unknown> {
  const { created, ran, outcome, links, ...rest } = view;
  void created;
  void ran;
  void outcome;
  void links;
  return rest;
}

describe("HTTP / CLI parity", () => {
  it("exposes an HTTP-created invocation identically through the CLI", async () => {
    const created = await http<Record<string, unknown>>(
      "POST",
      "/v1/workflows/hello-workflow/invocations",
      { body: { name: "http" }, headers: { "idempotency-key": "parity-http" } },
    );
    assert.equal(created.status, 202);
    const id = created.body.id as string;

    const fromCli = await cliJson<Record<string, unknown>>("invocations", "show", id);
    assert.deepEqual(fromCli, core(created.body));
    assert.equal(fromCli.status, "pending");
  });

  it("exposes a CLI-created invocation identically through HTTP", async () => {
    const created = await cliJson<Record<string, unknown>>(
      "invoke",
      "hello-workflow",
      "--input",
      '{"name":"cli"}',
      "--idempotency-key",
      "parity-cli",
      "--detach",
    );
    const id = created.id as string;

    const fromHttp = await http<Record<string, unknown>>("GET", `/v1/invocations/${id}`);
    assert.equal(fromHttp.status, 200);
    assert.deepEqual(fromHttp.body, core(created));
  });

  it("enforces the same idempotency key through both adapters", async () => {
    const viaHttp = await http<Record<string, unknown>>(
      "POST",
      "/v1/workflows/hello-workflow/invocations",
      { body: { name: "shared" }, headers: { "idempotency-key": "parity-shared" } },
    );
    const viaCli = await cliJson<Record<string, unknown>>(
      "invoke",
      "hello-workflow",
      "--input",
      '{"name":"ignored"}',
      "--idempotency-key",
      "parity-shared",
      "--detach",
    );

    assert.equal(viaCli.id, viaHttp.body.id);
    assert.equal(viaCli.created, false);
    assert.equal(viaHttp.body.created, true);
  });

  it("drives the same state machine from either tick entry point", async () => {
    const created = await cliJson<Record<string, unknown>>(
      "invoke",
      "hello-workflow",
      "--input",
      '{"name":"tick"}',
      "--detach",
    );
    const id = created.id as string;

    const tick = await http<{ skipped: boolean; runs: unknown[] }>(
      "POST",
      "/v1/runtime/tick",
      { body: { maxRuns: 20 } },
    );
    assert.equal(tick.status, 200);
    assert.equal(tick.body.skipped, false);

    const fromHttp = await http<Record<string, unknown>>("GET", `/v1/invocations/${id}`);
    const fromCli = await cliJson<Record<string, unknown>>("invocations", "show", id);
    assert.equal(fromCli.status, "completed");
    assert.deepEqual(fromCli, fromHttp.body);

    const journalHttp = await http<{ journal: unknown[] }>(
      "GET",
      `/v1/invocations/${id}/journal`,
    );
    const journalCli = await cliJson<{ journal: unknown[] }>("journal", "show", id);
    assert.deepEqual(journalCli.journal, journalHttp.body.journal);
    assert.equal(journalCli.journal.length, 3);
  });

  it("returns matching error shapes for a missing invocation", async () => {
    const fromHttp = await http<{ error: { code: string; message: string } }>(
      "GET",
      "/v1/invocations/does-not-exist",
    );
    assert.equal(fromHttp.status, 404);
    assert.equal(fromHttp.body.error.code, "NOT_FOUND");

    const result = await cli("invocations", "show", "does-not-exist", "--json");
    assert.equal(result.code, 2);
    const parsed = JSON.parse(result.stdout.trim()) as { error: { code: string; message: string } };
    assert.equal(parsed.error.code, "NOT_FOUND");
    assert.equal(parsed.error.message, fromHttp.body.error.message);
  });

  it("shares schedule management between adapters", async () => {
    const created = await http<Record<string, unknown>>("POST", "/v1/schedules", {
      body: {
        id: "parity-schedule",
        workflow: "hello-workflow",
        every: "1h",
        catchUp: "latest",
        input: { name: "scheduled" },
      },
    });
    assert.equal(created.status, 201);

    const listed = await cliJson<{ schedules: Record<string, unknown>[] }>(
      "schedules",
      "list",
    );
    assert.deepEqual(
      listed.schedules.find((schedule) => schedule.id === "parity-schedule"),
      created.body,
    );

    const disabled = await cliJson<Record<string, unknown>>(
      "schedules",
      "disable",
      "parity-schedule",
    );
    assert.equal(disabled.enabled, false);

    const fromHttp = await http<Record<string, unknown>>(
      "GET",
      "/v1/schedules/parity-schedule",
    );
    assert.deepEqual(fromHttp.body, disabled);

    const deleted = await http<{ deleted: string }>(
      "DELETE",
      "/v1/schedules/parity-schedule",
    );
    assert.equal(deleted.body.deleted, "parity-schedule");
    const after = await cliJson<{ schedules: unknown[] }>("schedules", "list");
    assert.equal(after.schedules.length, 0);
  });

  it("rejects a conflicting transition the same way in both adapters", async () => {
    const created = await cliJson<Record<string, unknown>>(
      "invoke",
      "hello-workflow",
      "--detach",
    );
    const id = created.id as string;

    const fromHttp = await http<{ error: { code: string } }>(
      "POST",
      `/v1/invocations/${id}/retry`,
    );
    assert.equal(fromHttp.status, 409);
    assert.equal(fromHttp.body.error.code, "CONFLICT");

    const result = await cli("invocations", "retry", id, "--json");
    assert.equal(result.code, 2);
    const parsed = JSON.parse(result.stdout.trim()) as { error: { code: string } };
    assert.equal(parsed.error.code, "CONFLICT");
  });

  it("reports health and registered workflows over HTTP", async () => {
    const health = await http<{ ok: boolean; schemaVersion: number }>("GET", "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const workflows = await http<{ workflows: { name: string }[] }>("GET", "/v1/workflows");
    const cliWorkflows = await cliJson<{ workflows: { name: string }[] }>(
      "workflows",
      "list",
    );
    assert.deepEqual(cliWorkflows.workflows, workflows.body.workflows);
  });

  it("returns 404 for unknown routes", async () => {
    const response = await http<{ error: { code: string } }>("GET", "/v1/nope");
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "NOT_FOUND");
  });
});
