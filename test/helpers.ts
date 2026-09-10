import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeApi } from "../src/core/runtime-api.ts";
import { WorkflowRegistry } from "../src/core/registry.ts";
import { SqliteStore } from "../src/storage/sqlite-store.ts";
import { silentLogger } from "../src/core/logger.ts";
import { InvocationRunner } from "../src/core/runner.ts";
import type { WorkflowDefinition } from "../src/core/types.ts";
import type { Logger } from "../src/core/logger.ts";

export interface TestRuntime {
  runtime: RuntimeApi;
  store: SqliteStore;
  registry: WorkflowRegistry;
  runner: InvocationRunner;
  now: () => number;
  advance: (ms: number) => void;
  setNow: (value: number) => void;
  close: () => void;
}

export const T0 = Date.UTC(2026, 7, 31, 0, 0, 0);

export function createTestRuntime(options: {
  workflows: WorkflowDefinition[];
  dbPath?: string;
  now?: number;
  leaseTtlMs?: number;
  logger?: Logger;
}): TestRuntime {
  const store = new SqliteStore({ path: options.dbPath ?? ":memory:" });
  const registry = new WorkflowRegistry(options.workflows);
  let clock = options.now ?? T0;
  const now = () => clock;

  const runtime = new RuntimeApi({
    store,
    registry,
    logger: options.logger ?? silentLogger,
    now,
    leaseTtlMs: options.leaseTtlMs ?? 5000,
  });
  runtime.init();

  const runner = new InvocationRunner({
    store,
    registry,
    logger: options.logger ?? silentLogger,
    now,
  });

  return {
    runtime,
    store,
    registry,
    runner,
    now,
    advance: (ms) => {
      clock += ms;
    },
    setNow: (value) => {
      clock = value;
    },
    close: () => runtime.close(),
  };
}

/** Temporary directory removed when the test finishes. */
export function tempDir(t: { after: (fn: () => void) => void }): string {
  const directory = mkdtempSync(join(tmpdir(), "mini-restate-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function tempDbPath(t: { after: (fn: () => void) => void }): string {
  return join(tempDir(t), "state.sqlite");
}
