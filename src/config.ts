import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isAbsolute, dirname, resolve } from "node:path";

import { ConfigError } from "./core/errors.ts";
import { JsonLogger } from "./core/logger.ts";
import { WorkflowRegistry } from "./core/registry.ts";
import { RuntimeApi } from "./core/runtime-api.ts";
import { SqliteStore } from "./storage/sqlite-store.ts";
import type { LogLevel, Logger } from "./core/logger.ts";
import type { RetryPolicy, WorkflowDefinition } from "./core/types.ts";

export interface MiniRestateConfig {
  /** SQLite file, resolved relative to the config file. */
  dbPath?: string;
  workflows: WorkflowDefinition[];
  http?: {
    host?: string;
    port?: number;
    /** Poll interval of the built-in runner loop; `0` disables it. */
    pollIntervalMs?: number;
  };
  runner?: {
    leaseTtlMs?: number;
    maxRuns?: number;
    defaultRetry?: RetryPolicy;
  };
  logLevel?: LogLevel;
}

export function defineConfig(config: MiniRestateConfig): MiniRestateConfig {
  return config;
}

export const DEFAULT_DB_PATH = ".mini-restate/state.sqlite";

export const CONFIG_FILENAMES = [
  "mini-restate.config.ts",
  "mini-restate.config.mts",
  "mini-restate.config.js",
  "mini-restate.config.mjs",
];

export interface LoadedConfig {
  config: MiniRestateConfig;
  configPath: string;
  dbPath: string;
}

/** Walks up from `cwd` looking for a config file, like a package manager would. */
export function findConfigFile(cwd = process.cwd()): string | null {
  let directory = resolve(cwd);
  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = resolve(directory, filename);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function loadConfig(options: {
  cwd?: string;
  path?: string;
  dbPath?: string;
} = {}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.path
    ? resolve(cwd, options.path)
    : findConfigFile(cwd);

  if (!configPath) {
    throw new ConfigError(
      `no config file found; create one of ${CONFIG_FILENAMES.join(", ")} ` +
        `in ${cwd} or pass --config <path>`,
    );
  }
  if (!existsSync(configPath)) {
    throw new ConfigError(`config file not found: ${configPath}`);
  }

  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(configPath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(
      `failed to load config ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      null,
    );
  }

  const exported = module.default ?? module.config;
  const config = (typeof exported === "function"
    ? await (exported as () => MiniRestateConfig | Promise<MiniRestateConfig>)()
    : exported) as MiniRestateConfig | undefined;

  if (!config || typeof config !== "object") {
    throw new ConfigError(
      `config ${configPath} must default-export an object created with defineConfig()`,
    );
  }
  if (!Array.isArray(config.workflows)) {
    throw new ConfigError(`config ${configPath} must define a \`workflows\` array`);
  }

  const configuredDbPath = options.dbPath ?? config.dbPath ?? DEFAULT_DB_PATH;
  const dbPath = configuredDbPath === ":memory:"
    ? ":memory:"
    : isAbsolute(configuredDbPath)
      ? configuredDbPath
      : resolve(dirname(configPath), configuredDbPath);

  return { config, configPath, dbPath };
}

export interface CreateRuntimeOptions {
  logger?: Logger;
  logLevel?: LogLevel;
  now?: () => number;
  ownerId?: string;
  /** Run migrations on open (default true). */
  migrate?: boolean;
}

/** Wires a config into a ready-to-use `RuntimeApi`. */
export function createRuntime(
  loaded: Pick<LoadedConfig, "config" | "dbPath">,
  options: CreateRuntimeOptions = {},
): RuntimeApi {
  const store = new SqliteStore({ path: loaded.dbPath });
  const registry = new WorkflowRegistry(loaded.config.workflows);
  const logger =
    options.logger ??
    new JsonLogger({
      level: options.logLevel ?? loaded.config.logLevel ?? "info",
    });

  const runtime = new RuntimeApi({
    store,
    registry,
    logger,
    now: options.now,
    ownerId: options.ownerId,
    leaseTtlMs: loaded.config.runner?.leaseTtlMs,
    defaultRetry: loaded.config.runner?.defaultRetry,
  });

  if (options.migrate !== false) runtime.init();
  return runtime;
}
