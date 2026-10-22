import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { DuexError, UsageError } from "../core/errors.ts";
import { MAX_PAYLOAD_BYTES } from "../core/json.ts";
import { silentLogger } from "../core/logger.ts";
import { invocationView, journalView, scheduleView } from "../core/views.ts";
import type { Logger } from "../core/logger.ts";
import type { RuntimeApi } from "../core/runtime-api.ts";
import type { CatchUpPolicy, InvocationStatus, Json } from "../core/types.ts";

/**
 * HTTP ingress adapter.
 *
 * A first-class front door alongside the CLI: every RuntimeApi use case is
 * reachable here, and both adapters return the same view objects. The adapter
 * only does routing, JSON serde and status-code mapping (design doc D2).
 */

export interface HttpServerOptions {
  runtime: RuntimeApi;
  logger?: Logger;
  /** Runs `tick` on an interval so `serve` needs no external timer. `0` disables. */
  pollIntervalMs?: number;
  maxRunsPerPoll?: number;
}

const STATUS_BY_CODE: Record<string, number> = {
  USAGE: 400,
  SERIALIZATION: 400,
  CONFIG: 400,
  NON_DETERMINISTIC: 409,
  CONFLICT: 409,
  NOT_FOUND: 404,
  TERMINAL: 500,
};

type Handler = (
  context: RequestContext,
) => Promise<{ status: number; body: Json } | void> | { status: number; body: Json } | void;

interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<Json>;
  header: (name: string) => string | undefined;
}

interface Route {
  method: string;
  pattern: string[];
  handler: Handler;
}

export function createHttpServer(options: HttpServerOptions): {
  server: Server;
  stopPolling: () => void;
} {
  const runtime = options.runtime;
  const logger = options.logger ?? silentLogger;
  const routes = buildRoutes(runtime);

  const server = createServer((request, response) => {
    handleRequest(routes, request, response, logger).catch((error: unknown) => {
      logger.error("http.unhandled", { message: String(error) });
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { code: "INTERNAL", message: "internal error" } }));
    });
  });

  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  let timer: NodeJS.Timeout | null = null;
  if (pollIntervalMs > 0) {
    let ticking = false;
    timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void runtime
        .tick({ maxRuns: options.maxRunsPerPoll ?? 20 })
        .catch((error: unknown) => {
          logger.error("http.tick_failed", { message: String(error) });
        })
        .finally(() => {
          ticking = false;
        });
    }, pollIntervalMs);
    timer.unref?.();
  }

  return {
    server,
    stopPolling: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export interface StartedHttpServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startHttpServer(
  options: HttpServerOptions & { host?: string; port?: number },
): Promise<StartedHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8080;
  const logger = options.logger ?? silentLogger;

  if (host === "0.0.0.0" || host === "::") {
    logger.warn("http.public_bind", {
      host,
      message:
        "duex has no authentication; binding beyond loopback exposes " +
        "arbitrary workflow execution",
    });
  }

  const { server, stopPolling } = createHttpServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    host: address.address,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: async () => {
      stopPolling();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ------------------------------------------------------------------- routing

function buildRoutes(runtime: RuntimeApi): Route[] {
  const route = (method: string, path: string, handler: Handler): Route => ({
    method,
    pattern: path.split("/").filter(Boolean),
    handler,
  });

  return [
    route("GET", "/healthz", () => ({
      status: 200,
      body: runtime.health() as unknown as Json,
    })),

    route("GET", "/v1/workflows", () => ({
      status: 200,
      body: { workflows: runtime.workflows() } as unknown as Json,
    })),

    route("POST", "/v1/workflows/:name/invocations", async (context) => {
      const body = await context.body();
      const idempotencyKey =
        context.header("idempotency-key") ??
        context.url.searchParams.get("idempotencyKey") ??
        null;
      const lane = context.url.searchParams.get("lane");
      const wait = boolParam(context.url.searchParams.get("wait"));

      const result = await runtime.invoke({
        workflow: context.params.name,
        input: body,
        idempotencyKey,
        lane,
        wait,
        waitTimeoutMs: intParam(context.url.searchParams.get("waitTimeoutMs")) ?? undefined,
      });

      const view = invocationView(result.invocation);
      return {
        status: result.created ? 202 : 200,
        body: {
          ...(view as unknown as Record<string, Json>),
          created: result.created,
          ran: result.ran,
          outcome: result.outcome ?? null,
          links: {
            self: `/v1/invocations/${result.invocation.id}`,
            journal: `/v1/invocations/${result.invocation.id}/journal`,
          },
        } as unknown as Json,
      };
    }),

    route("GET", "/v1/invocations", (context) => {
      const statusParam = context.url.searchParams.getAll("status");
      const invocations = runtime.listInvocations({
        status: statusParam.length > 0 ? (statusParam as InvocationStatus[]) : undefined,
        workflowName: context.url.searchParams.get("workflow") ?? undefined,
        scheduleId: context.url.searchParams.get("scheduleId") ?? undefined,
        limit: intParam(context.url.searchParams.get("limit")) ?? 50,
        offset: intParam(context.url.searchParams.get("offset")) ?? 0,
        order: context.url.searchParams.get("order") === "asc" ? "asc" : "desc",
      });
      return {
        status: 200,
        body: { invocations: invocations.map(invocationView) } as unknown as Json,
      };
    }),

    route("GET", "/v1/invocations/:id", (context) => ({
      status: 200,
      body: invocationView(runtime.getInvocation(context.params.id)) as unknown as Json,
    })),

    route("GET", "/v1/invocations/:id/journal", (context) => ({
      status: 200,
      body: {
        invocationId: context.params.id,
        journal: runtime.getJournal(context.params.id).map(journalView),
      } as unknown as Json,
    })),

    route("POST", "/v1/invocations/:id/retry", (context) => ({
      status: 200,
      body: invocationView(runtime.retryInvocation(context.params.id)) as unknown as Json,
    })),

    route("POST", "/v1/invocations/:id/cancel", (context) => ({
      status: 200,
      body: invocationView(runtime.cancelInvocation(context.params.id)) as unknown as Json,
    })),

    route("GET", "/v1/schedules", () => ({
      status: 200,
      body: { schedules: runtime.listSchedules().map(scheduleView) } as unknown as Json,
    })),

    route("POST", "/v1/schedules", async (context) => {
      const body = (await context.body()) as Record<string, Json> | null;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new UsageError("schedule body must be a JSON object");
      }
      const schedule = runtime.createSchedule({
        id: String(body.id ?? ""),
        workflow: String(body.workflow ?? ""),
        input: body.input ?? null,
        lane: (body.lane as string | null | undefined) ?? null,
        every: (body.every as string | number) ?? 0,
        catchUp: (body.catchUp as CatchUpPolicy | undefined) ?? undefined,
        maxCatchUp: (body.maxCatchUp as number | undefined) ?? undefined,
        startAt: (body.startAt as number | undefined) ?? undefined,
        enabled: (body.enabled as boolean | undefined) ?? undefined,
      });
      return { status: 201, body: scheduleView(schedule) as unknown as Json };
    }),

    route("GET", "/v1/schedules/:id", (context) => ({
      status: 200,
      body: scheduleView(runtime.getSchedule(context.params.id)) as unknown as Json,
    })),

    route("POST", "/v1/schedules/:id/enable", (context) => ({
      status: 200,
      body: scheduleView(
        runtime.setScheduleEnabled(context.params.id, true),
      ) as unknown as Json,
    })),

    route("POST", "/v1/schedules/:id/disable", (context) => ({
      status: 200,
      body: scheduleView(
        runtime.setScheduleEnabled(context.params.id, false),
      ) as unknown as Json,
    })),

    route("DELETE", "/v1/schedules/:id", (context) => {
      runtime.deleteSchedule(context.params.id);
      return { status: 200, body: { deleted: context.params.id } };
    }),

    route("POST", "/v1/runtime/tick", async (context) => {
      const body = (await context.body()) as Record<string, Json> | null;
      const result = await runtime.tick({
        maxRuns:
          (body?.maxRuns as number | undefined) ??
          intParam(context.url.searchParams.get("maxRuns")) ??
          undefined,
        concurrency:
          (body?.concurrency as number | undefined) ??
          intParam(context.url.searchParams.get("concurrency")) ??
          undefined,
      });
      return { status: 200, body: result as unknown as Json };
    }),

    route("GET", "/v1/runtime/doctor", () => {
      const report = runtime.doctor();
      return { status: report.ok ? 200 : 503, body: report as unknown as Json };
    }),

    route("GET", "/v1/export", (context) => ({
      status: 200,
      body: runtime.exportInvocations({
        id: context.url.searchParams.get("id") ?? undefined,
        limit: intParam(context.url.searchParams.get("limit")) ?? undefined,
      }) as unknown as Json,
    })),
  ];
}

async function handleRequest(
  routes: Route[],
  request: IncomingMessage,
  response: ServerResponse,
  logger: Logger,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const segments = url.pathname.split("/").filter(Boolean);
  const startedAt = Date.now();

  for (const route of routes) {
    if (route.method !== (request.method ?? "GET")) continue;
    const params = matchRoute(route.pattern, segments);
    if (!params) continue;

    try {
      const result = await route.handler({
        request,
        response,
        url,
        params,
        body: () => readJsonBody(request),
        header: (name) => {
          const value = request.headers[name.toLowerCase()];
          return Array.isArray(value) ? value[0] : value;
        },
      });
      const status = result?.status ?? 204;
      const body = result?.body ?? null;
      send(response, status, body);
      logger.debug("http.request", {
        method: request.method ?? "GET",
        path: url.pathname,
        status,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const { status, body } = errorResponse(error);
      send(response, status, body);
      logger.warn("http.error", {
        method: request.method ?? "GET",
        path: url.pathname,
        status,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  send(response, 404, {
    error: { code: "NOT_FOUND", message: `no route for ${request.method} ${url.pathname}` },
  });
}

function matchRoute(
  pattern: string[],
  segments: string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index];
    if (part.startsWith(":")) {
      params[part.slice(1)] = decodeURIComponent(segments[index]);
    } else if (part !== segments[index]) {
      return null;
    }
  }
  return params;
}

export function errorResponse(error: unknown): { status: number; body: Json } {
  if (error instanceof DuexError) {
    return {
      status: STATUS_BY_CODE[error.code] ?? 500,
      body: {
        error: {
          code: error.code,
          message: error.message,
          detail: error.detail ?? null,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL",
        message: error instanceof Error ? error.message : String(error),
        detail: null,
      },
    },
  };
}

function send(response: ServerResponse, status: number, body: Json): void {
  const text = JSON.stringify(body ?? null);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

async function readJsonBody(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_PAYLOAD_BYTES) {
      throw new UsageError(`request body exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  if (size === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return null;
  try {
    return JSON.parse(text) as Json;
  } catch (error) {
    throw new UsageError(
      `invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function boolParam(value: string | null): boolean {
  return value === "" || value === "1" || value === "true";
}

function intParam(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new UsageError(`expected an integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}
