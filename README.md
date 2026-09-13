# duex

A small durable workflow runtime for TypeScript. Workflows are plain
`async` functions; SQLite is the single source of truth for execution state.

Restate's core idea — replay a handler from the top and serve completed
operations from a journal — without a server, cluster, or deployment story.

- **No resident process required.** `launchd → duex tick` drains due work.
- **CLI and HTTP are equal front doors** over the same `RuntimeApi`.
- **One file to back up:** `state.sqlite` holds every invocation, journal, timer, and schedule.
- **Zero runtime dependencies.** Uses `node:sqlite`, `node:http`, and `node:test`.

Requires **Node.js 24+** (native TypeScript type stripping and `node:sqlite`).

## Quick start

```bash
npm install @jugyo/duex
npx duex init
npx duex invoke hello-workflow --input '{"name":"jugyo"}' --wait
npx duex journal show <INVOCATION_ID>
```

## Writing a workflow

```ts
import { defineWorkflow } from "@jugyo/duex";

export const fishingAdvisor = defineWorkflow({
  name: "fishing-advisor",
  version: "1",
  async run(ctx, input) {
    const config = await ctx.run("config.snapshot", () => resolveConfig(input));
    const weather = await ctx.run("weather.fetch", () => fetchWeather(config), {
      retry: { maxAttempts: 5, initialDelayMs: 250, factor: 2 },
    });
    const advice = await ctx.run("agent.evaluate", () => evaluate(weather));
    await ctx.run("notification.send", () =>
      notify(advice, `${ctx.invocationId}:notification.send`),
    );
    return advice;
  },
});
```

Register workflows in `duex.config.ts`:

```ts
import { defineConfig } from "@jugyo/duex";

export default defineConfig({
  dbPath: ".duex/state.sqlite",
  workflows: [helloWorkflow, fishingAdvisor],
  http: { host: "127.0.0.1", port: 8080, pollIntervalMs: 1000 },
  runner: { leaseTtlMs: 60_000, maxRuns: 20 },
});
```

### Context API

- `ctx.run(name, fn, opts?)` — run `fn` at most once; result is journaled and replayed
- `ctx.sleep(name, "1h")` — persist wake time and suspend; a later `tick` resumes
- `ctx.now(name)` / `ctx.uuid(name)` — journaled clock / UUID, stable across replays

Call durable operations in the same order on every replay. Put external I/O inside
`ctx.run()`. Do not call `ctx.*` from inside a `ctx.run()` callback or start two
concurrently. Inputs, outputs, and errors must be JSON-serializable (≤ 1 MiB).
Changing steps of a released workflow means bumping `version`.

## CLI

```bash
duex init
duex invoke <workflow> --input '{"a":1}' --wait
duex tick --max-runs 20
duex journal show <id>
duex schedules create hourly-job --workflow fishing-advisor --every 1h
duex serve --host 127.0.0.1 --port 8080
```

Also: `workflows list`, `invocations list|show|retry|cancel`, `schedules list|show|enable|disable|delete`,
`doctor`, `export`. Global flags: `--config`, `--db`, `--json`, `--log-level`, `--quiet`.

## HTTP

`duex serve` exposes the same use cases and runs its own runner loop.
It binds to `127.0.0.1` by default and has **no authentication** — do not expose it.

```bash
curl -X POST http://127.0.0.1:8080/v1/workflows/fishing-advisor/invocations \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: fishing-2026-08-31T10' \
  -d '{"location":"Hakata Bay"}'
```

Routes under `/v1/` cover workflows, invocations, journals, schedules, tick, doctor, and export.
CLI and HTTP return the same view objects for a given record.

## Running without a resident process

```
launchd ── every 60s ──► duex tick --max-runs 20
```

Each tick acquires the runner lease, materializes due schedules, recovers orphans,
wakes timers, runs pending work, then exits. See
[`examples/launchd/com.duex.tick.plist`](examples/launchd/com.duex.tick.plist).
While the machine sleeps nothing runs; the first tick after wake applies the
schedule's catch-up policy (`latest` by default, or `all` / `skip`).

## Guarantees

- One invocation per idempotency key
- A step journaled as `completed` never runs again
- Sleep, retry, and schedule times survive restarts
- Only one runner executes handlers at a time (SQLite lease)

**Not** guaranteed: external side effects are **at-least-once**. If the process
dies after a side effect succeeds but before the journal commit, that step is
retried. Derive an idempotency key from `ctx.invocationId` + step name and
de-duplicate downstream.

## Using as a package

The published package ships compiled `dist/` (`.js` + `.d.ts`). Build with
`npm run build` (`prepack` runs this before `npm pack` / `npm publish`).

```ts
import { defineWorkflow, defineConfig } from "@jugyo/duex";
```

For a `file:` dependency, build this repo first (`npm install && npm run build`)
so the symlink points at a populated `dist/`. In-repo development can run TypeScript
directly via `npm run duex` (`node ./bin/duex.ts`).

## Develop

```bash
npm test
npm run typecheck
```
