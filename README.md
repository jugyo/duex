# mini-restate

A small, local-only durable workflow runtime for TypeScript. Workflows are plain
`async` functions; SQLite is the single source of truth for execution state.

Implements [`docs/mini-restate-design.md`](../local-workflow-2/docs/mini-restate-design.md)
— Restate's core idea (replay a handler from the top and serve completed
operations from a journal) without the server, the cluster or the deployment
story.

- **No resident process required.** `launchd → mini-restate tick` drains due work.
- **Two equal front doors.** The CLI and the HTTP API are both first-class
  ingress adapters over the same `RuntimeApi`; neither owns any workflow logic.
- **One file to back up.** Copy `state.sqlite` and you have every invocation,
  journal, timer and schedule.
- **Zero runtime dependencies.** `node:sqlite`, `node:http`, `node:test`.

Requires Node.js 24+ (uses native TypeScript type stripping and `node:sqlite`).

## Quick start

```bash
node bin/mini-restate.ts init
node bin/mini-restate.ts invoke hello-workflow --input '{"name":"jugyo"}' --wait
node bin/mini-restate.ts journal show <INVOCATION_ID>
```

```
SEQ  KIND  NAME             STATUS     ATTEMPT  DURATION  RESULT
0    run   greeting.build   completed  0        0ms       "hello, jugyo!"
1    now   greeting.time    completed  0        0ms       1788166368642
2    uuid  greeting.run-id  completed  0        0ms       "e33dda78-…"
```

## Writing a workflow

```ts
import { defineWorkflow } from "./src/index.ts";

export const fishingAdvisor = defineWorkflow({
  name: "fishing-advisor",
  version: "1",
  async run(ctx, input) {
    const config = await ctx.run("config.snapshot", () => resolveConfig(input));

    const weather = await ctx.run("weather.fetch", () => fetchWeather(config), {
      retry: { maxAttempts: 5, initialDelayMs: 250, factor: 2 },
    });
    const marine = await ctx.run("marine.fetch", () => fetchMarine(config), {
      retry: { maxAttempts: 5, initialDelayMs: 250, factor: 2 },
    });

    const advice = await ctx.run("agent.evaluate", () => evaluate(weather, marine));

    await ctx.run("notification.send", () =>
      notify(advice, `${ctx.invocationId}:notification.send`),
    );

    return advice;
  },
});
```

Register it in `mini-restate.config.ts`:

```ts
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  dbPath: ".mini-restate/state.sqlite",
  workflows: [helloWorkflow, fishingAdvisor],
  http: { host: "127.0.0.1", port: 8080, pollIntervalMs: 1000 },
  runner: { leaseTtlMs: 60_000, maxRuns: 20 },
});
```

### Context API

| Call | Durable behaviour |
|---|---|
| `ctx.run(name, fn, opts?)` | Runs `fn` at most once per invocation; the result is journaled and replayed |
| `ctx.sleep(name, "1h")` | Persists the wake time and suspends; a later `tick` resumes the handler |
| `ctx.now(name)` | Journaled wall clock — stable across replays |
| `ctx.uuid(name)` | Journaled UUID v4 — stable across replays |

### Determinism contract

- Call the same durable operations in the same order on every replay.
- Use `ctx.now()` / `ctx.uuid()` instead of `Date.now()` / `crypto.randomUUID()`.
- Do all external I/O inside `ctx.run()`, and never call `ctx.*` from inside a
  `ctx.run()` callback or start two of them concurrently — both are detected and
  fail the invocation with `NonDeterministicWorkflowError`.
- Every input, output and error must be JSON-serializable (≤ 1 MiB per entry).
  `undefined`, functions, class instances and cycles are rejected up front.

Changing the steps of a released workflow means bumping `version`: an invocation
records the version it started with and is never auto-run against a different one.

## CLI

```bash
mini-restate init                                  # create the DB, run migrations
mini-restate workflows list
mini-restate invoke <workflow> --input @in.json --wait
mini-restate invoke <workflow> --input '{"a":1}' \
  --idempotency-key daily-2026-08-31 --detach
mini-restate tick --max-runs 20                    # drain due work, then exit
mini-restate invocations list --status failed
mini-restate invocations show <id>
mini-restate invocations retry <id>
mini-restate invocations cancel <id>
mini-restate journal show <id>
mini-restate schedules create hourly-fishing-advisor \
  --workflow fishing-advisor --every 1h --input @input.json --catch-up latest
mini-restate schedules list|show|enable|disable|delete
mini-restate doctor
mini-restate export --id <id> --out dump.json
mini-restate serve --host 127.0.0.1 --port 8080
```

アプリケーション API の `createDailySchedule` は `dailyAt`（`HH:MM`）と IANA timezone を受け取り、DST を含む現地 calendar に従います。存在しない現地時刻は gap 後の最初の有効な時刻へ進め、重複する現地時刻は早い方の instant を選びます。fixed interval と daily calendar は同じ schedule table、materializer、slot idempotency key を共有します。

daily invocation は materialize 時点の今回枠を `WorkflowContext.scheduledAt`、直前枠を `WorkflowContext.scheduledFrom` として永続化します。schedule 定義が後から変更されても、作成済み invocation の calendar window は変わりません。

Global flags: `--config <path>`, `--db <path>`, `--json`, `--log-level`, `--quiet`.
With `--json`, stdout carries only JSON; diagnostics go to stderr.

| Exit code | Meaning |
|---|---|
| `0` | success, enqueued, or another runner is active (safe skip) |
| `2` | usage / input validation error |
| `3` | workflow terminal failure |
| `4` | config, schema or version mismatch |
| `5` | internal runtime or storage error |

## HTTP

`mini-restate serve` exposes the same use cases and runs its own runner loop.
It binds to `127.0.0.1` by default and has **no authentication** — do not expose it.

| Method | Path |
|---|---|
| `GET` | `/healthz` |
| `GET` | `/v1/workflows` |
| `POST` | `/v1/workflows/{name}/invocations` (`Idempotency-Key` header, `?wait=true`) |
| `GET` | `/v1/invocations?status=&workflow=&limit=&offset=` |
| `GET` | `/v1/invocations/{id}` |
| `GET` | `/v1/invocations/{id}/journal` |
| `POST` | `/v1/invocations/{id}/retry` |
| `POST` | `/v1/invocations/{id}/cancel` |
| `GET`/`POST` | `/v1/schedules`, `GET`/`DELETE` `/v1/schedules/{id}` |
| `POST` | `/v1/schedules/{id}/enable`, `/v1/schedules/{id}/disable` |
| `POST` | `/v1/runtime/tick` |
| `GET` | `/v1/runtime/doctor` |
| `GET` | `/v1/export?id=&limit=` |

```bash
curl -X POST http://127.0.0.1:8080/v1/workflows/fishing-advisor/invocations \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: fishing-2026-08-31T10' \
  -d '{"location":"Hakata Bay"}'
```

CLI and HTTP return byte-identical view objects for the same record; the parity
test in `test/http-cli-parity.test.ts` asserts it.

## Running without a resident process

```
launchd ── every 60s ──► mini-restate tick --max-runs 20
                            ├─ acquire the runner lease (exit 0 if taken)
                            ├─ materialize due schedules
                            ├─ recover invocations orphaned by a dead runner
                            ├─ wake due sleep / retry timers
                            └─ run pending invocations, then exit
```

See [`examples/launchd/com.mini-restate.tick.plist`](examples/launchd/com.mini-restate.tick.plist).
While the machine is asleep nothing runs; the first tick after wake applies the
schedule's catch-up policy.

| Catch-up | 5 missed hours | Use for |
|---|---|---|
| `latest` (default) | one invocation for the newest slot | weather, notifications, snapshots |
| `all` | one per slot, `maxCatchUp` (100) per tick, rest deferred | ledgers, aggregation |
| `skip` | none | jobs with no value once stale |

Schedule-derived invocations use the deterministic key
`schedule:{scheduleId}:{scheduledAt}`, so re-materializing a slot can never
duplicate it.

## Guarantees

Guaranteed:

- one invocation per idempotency key;
- a step journaled as `completed` never runs again;
- sleep, retry and schedule times survive restarts;
- only one runner executes handlers at a time (renewable SQLite lease);
- schedule materialization and `next_run_at` advance atomically.

**Not** guaranteed — external side effects are **at-least-once**. If the process
dies after a side effect succeeds but before the journal commit, that step is
retried. Derive an idempotency key from `ctx.invocationId` + step name and
de-duplicate downstream.

## Using mini-restate as a package

配布されるのは `dist/` に出力されたコンパイル済みコードです。Node は `node_modules`
配下の `.ts` を type stripping しないため、利用側が素の `node` で動く条件を満たすには
`.js` と `.d.ts` を配布する必要があります。package 契約は次のとおりです。

| Field | Value |
|---|---|
| `name` | `mini-restate` |
| `license` | `MIT` |
| `main` | `./dist/src/index.js` |
| `types` | `./dist/src/index.d.ts` |
| `exports["."]` | `types` → `./dist/src/index.d.ts`、`default` → `./dist/src/index.js` |
| `bin.mini-restate` | `./dist/bin/mini-restate.js`（`bin/mini-restate.ts` の出力） |
| `files` | `dist/`、`LICENSE`、`README.md` |

```bash
npm run build     # tsc -p tsconfig.build.json → dist/*.js, *.d.ts, *.map
```

`dist/` は git 管理外です。`prepack` が `npm pack` / `npm publish` の直前に build を
実行するので、tarball には常に最新の `dist/` が入ります。

### file: 依存で使う

```jsonc
// 利用側の package.json
{ "dependencies": { "mini-restate": "file:../mini-restate" } }
```

`file:` 依存は symlink になるため、`prepack` は走りません。利用側で `npm install` する前に、
mini-restate 側で一度 build しておいてください。

```bash
cd ../mini-restate && npm install && npm run build
```

`src/` を編集したら、利用側から見える内容を更新するために `npm run build` を再実行します。
リポジトリ内での開発時は build 不要で、`npm run mini-restate`（`node ./bin/mini-restate.ts`）が
`src/` の TypeScript を直接実行します。

利用側からは package 名で import します。

```ts
import { defineWorkflow, defineConfig } from "mini-restate";
```

### npm pack / 公開準備

`private` は外してあり、`license` / `author` / `keywords` と `LICENSE` も揃えている。
`npm pack`（`prepack` → build）で tarball を作れ、別ディレクトリへ install して
ライブラリ import と CLI の両方を実行できる。実際の `npm publish`（レジストリへの本番公開）は
このリポジトリの作業範囲外で、公開時に必要なのは `npm publish` の実行だけである。

デモ用のルート `mini-restate.config.ts` や `src/` / `test/` / ローカル DB は `files` に含めていない。

## Layout

```
src/core/       runtime-api, runner, replay-context, scheduler, lease, registry
src/storage/    Store interface, node:sqlite driver, migrations
src/adapters/   cli.ts, http.ts  (thin, no workflow semantics)
src/workflows/  hello-workflow, fishing-advisor (acceptance app)
test/           unit, replay, crash-recovery, scheduling, idempotency, parity
```

## Tests

```bash
npm test        # 71 tests: unit + integration (spawns real processes)
npm run typecheck
```

`test/crash-recovery.test.ts` kills real CLI processes at each point of the
design's crash matrix and asserts what gets replayed versus re-executed.
