import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { SqliteStore } from "../src/storage/sqlite-store.ts";
import { tempDir } from "./helpers.ts";

/**
 * Integration tests that spawn real CLI processes and kill them at the crash
 * points from the design doc's crash matrix (§18).
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "bin", "mini-restate.mjs");
const CONFIG = join(ROOT, "test", "fixtures", "crash-app", "mini-restate.config.ts");
const LEASE_TTL_MS = 300;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: <T>() => T;
}

function cli(
  args: string[],
  options: { dbPath: string; env?: Record<string, string> } = { dbPath: "" },
): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    [BIN, ...args, "--config", CONFIG, "--db", options.dbPath, "--quiet"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        MINI_RESTATE_LEASE_TTL_MS: String(LEASE_TTL_MS),
        ...(options.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
        json: <T,>() => JSON.parse(stdout.trim()) as T,
      });
    });
  });
}

function steps(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

function inspect<T>(dbPath: string, fn: (store: SqliteStore) => T): T {
  const store = new SqliteStore({ path: dbPath });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

async function setup(t: { after: (fn: () => void) => void }): Promise<{
  dbPath: string;
  logPath: string;
  id: string;
}> {
  const directory = tempDir(t);
  const dbPath = join(directory, "state.sqlite");
  const logPath = join(directory, "steps.log");

  const init = await cli(["init"], { dbPath });
  assert.equal(init.code, 0, init.stderr);

  const invoke = await cli(
    ["invoke", "crash-workflow", "--detach", "--json"],
    { dbPath, env: { MINI_RESTATE_STEP_LOG: logPath } },
  );
  assert.equal(invoke.code, 0, invoke.stderr);
  const { id } = invoke.json<{ id: string }>();
  return { dbPath, logPath, id };
}

describe("crash recovery", () => {
  it("does not re-run a completed step after a crash before the commit", async (t) => {
    const { dbPath, logPath, id } = await setup(t);

    // Crash point: side effect done, journal `completed` not yet written.
    const crashed = await cli(["tick", "--max-runs", "1"], {
      dbPath,
      env: { MINI_RESTATE_STEP_LOG: logPath, MINI_RESTATE_CRASH_AT: "after:step-two" },
    });
    assert.equal(crashed.code, 9, "the fixture must kill the process");
    assert.deepEqual(steps(logPath), ["step-one", "step-two"]);

    const midFlight = inspect(dbPath, (store) => ({
      invocation: store.getInvocation(id)!,
      journal: store.listJournal(id),
    }));
    assert.equal(midFlight.invocation.status, "running", "the lease holder died");
    assert.equal(midFlight.journal[0].status, "completed");
    assert.equal(midFlight.journal[1].status, "running");

    // The orphaned `running` row is only recoverable once the lease expires.
    const blocked = await cli(["tick", "--max-runs", "1", "--json"], { dbPath });
    assert.equal(blocked.json<{ skipped: boolean }>().skipped, true);

    await delay(LEASE_TTL_MS + 100);
    const recovered = await cli(["tick", "--max-runs", "1", "--json"], {
      dbPath,
      env: { MINI_RESTATE_STEP_LOG: logPath },
    });
    assert.equal(recovered.code, 0, recovered.stderr);
    const summary = recovered.json<{ recovered: number; runs: { outcome: string }[] }>();
    assert.equal(summary.recovered, 1);
    assert.equal(summary.runs[0].outcome, "completed");

    assert.deepEqual(
      steps(logPath),
      ["step-one", "step-two", "step-two", "step-three"],
      "only the uncommitted step is retried; step-one is replayed from the journal",
    );

    const done = inspect(dbPath, (store) => store.getInvocation(id)!);
    assert.equal(done.status, "completed");
    assert.deepEqual(done.output, { first: "one", second: "two", third: "three" });
  });

  it("retries a step that crashed before its side effect", async (t) => {
    const { dbPath, logPath, id } = await setup(t);

    const crashed = await cli(["tick", "--max-runs", "1"], {
      dbPath,
      env: { MINI_RESTATE_STEP_LOG: logPath, MINI_RESTATE_CRASH_AT: "before:step-two" },
    });
    assert.equal(crashed.code, 9);
    assert.deepEqual(steps(logPath), ["step-one"]);

    await delay(LEASE_TTL_MS + 100);
    const recovered = await cli(["tick", "--max-runs", "1", "--json"], {
      dbPath,
      env: { MINI_RESTATE_STEP_LOG: logPath },
    });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.deepEqual(steps(logPath), ["step-one", "step-two", "step-three"]);
    assert.equal(inspect(dbPath, (store) => store.getInvocation(id)!.status), "completed");
  });

  it("survives a crash before the invocation is claimed", async (t) => {
    const { dbPath, logPath, id } = await setup(t);

    assert.equal(inspect(dbPath, (store) => store.getInvocation(id)!.status), "pending");
    assert.deepEqual(steps(logPath), []);

    const tick = await cli(["tick", "--max-runs", "1", "--json"], {
      dbPath,
      env: { MINI_RESTATE_STEP_LOG: logPath },
    });
    assert.equal(tick.code, 0, tick.stderr);
    assert.deepEqual(steps(logPath), ["step-one", "step-two", "step-three"]);
  });

  it("runs handlers in only one of two concurrent tick processes", async (t) => {
    const directory = tempDir(t);
    const dbPath = join(directory, "state.sqlite");
    const logPath = join(directory, "steps.log");
    const env = { MINI_RESTATE_STEP_LOG: logPath, MINI_RESTATE_SLOW_MS: "700" };

    assert.equal((await cli(["init"], { dbPath })).code, 0);
    for (let index = 0; index < 2; index += 1) {
      const invoke = await cli(["invoke", "slow-workflow", "--detach"], { dbPath, env });
      assert.equal(invoke.code, 0, invoke.stderr);
    }

    const [a, b] = await Promise.all([
      cli(["tick", "--max-runs", "10", "--json"], { dbPath, env }),
      cli(["tick", "--max-runs", "10", "--json"], { dbPath, env }),
    ]);

    const results = [a, b].map((result) =>
      result.json<{ skipped: boolean; runs: unknown[] }>(),
    );
    const skipped = results.filter((result) => result.skipped);
    const worked = results.filter((result) => !result.skipped);

    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    assert.equal(skipped.length, 1, "exactly one runner must stand down");
    assert.equal(worked[0].runs.length, 2);
    assert.deepEqual(steps(logPath), ["slow", "slow"], "each step runs exactly once");
  });
});
