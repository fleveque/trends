# Trends — tech deep-dive for non-Node developers

This document walks through every layer of Trends from the perspective of an
engineer who already builds production services in **Ruby on Rails**,
**Elixir / Phoenix**, or **Go**, but has not worked seriously in
Node.js / TypeScript before. Goal: after one read you should be able to
navigate the code, change it safely, and know why each choice was made.

The siblings in our ecosystem give us natural reference points:

| Stack you might know | Sibling in the ecosystem |
|---|---|
| Ruby on Rails | `dividend-portfolio` |
| Elixir / Phoenix | `pulse` |
| Go | `logo-service` |

Where helpful, each section ends with a "Coming from X" cross-reference.

---

## Table of contents

1. [Why Node/TypeScript for this service](#1-why-nodetypescript-for-this-service)
2. [The Node runtime model](#2-the-node-runtime-model)
3. [TypeScript essentials](#3-typescript-essentials)
4. [NestJS architecture](#4-nestjs-architecture)
5. [Prisma vs ActiveRecord / Ecto / database/sql](#5-prisma-vs-activerecord--ecto--databasesql)
6. [NATS integration — `nats.js` directly](#6-nats-integration--natsjs-directly)
7. [Async, errors, and the promise model](#7-async-errors-and-the-promise-model)
8. [Testing](#8-testing)
9. [Build & deploy](#9-build--deploy)
10. [Observability & privacy](#10-observability--privacy)
11. [Glossary & toolchain](#11-glossary--toolchain)

---

## 1. Why Node/TypeScript for this service

Trends is shaped like a long-running I/O multiplexer: subscribe to N NATS
subjects, decode JSON, write to Postgres, serve a thin HTTP read API. Almost
every operation is "wait for I/O." Node's single-threaded event loop is built
for exactly this shape, and TypeScript gives us:

- **Contract safety** against Quantic's payloads. Quantic emits versioned JSON
  (`version: 2`), and we want the compiler to scream when we drift.
- **Marketable surface area.** This is also a learning project — Node + TS
  is one of the two or three most common backend stacks in the job market.

For Rails / Phoenix / Go folks, none of "Node is async" or "TS is typed" is
news. The thing worth internalising is: **you never block the loop.** More on
that in §2.

---

## 2. The Node runtime model

Node runs your code in a single OS thread, scheduled by an **event loop**.
Whenever your code hits an I/O boundary (file read, HTTP call, DB query,
NATS receive), it hands the work to libuv (Node's I/O engine), yields back to
the loop, and resumes when the I/O completes. **There is no preemption.** If
you write a CPU-heavy `for` loop that takes 5 seconds, every other request in
flight waits 5 seconds. There is no GVL/scheduler/runtime that will save you.

### Coming from Ruby

Imagine a Rails app where EventMachine is on by default for every gem, and
`puma` is replaced by a single worker. You get high concurrency for I/O-bound
work for free, but every CPU-bound bit of code is a contention point. There's
no MRI GVL stealing time slices — the only way the loop yields is when *you*
`await` something.

### Coming from Elixir

Conceptually it's the *opposite* of BEAM. There are no lightweight processes,
no preemptive scheduling, no isolated heaps. **One process, one heap, one
scheduler, no isolation.** An unhandled exception in one request handler can
crash the whole server. Supervision trees do not exist; the equivalent is
Docker + Kamal restarting the container.

The thing that does map: an `async` function that `await`s something is a
*lot* like a `GenServer` handler that does an `:erpc.call`. You yield,
something else runs, you resume.

### Coming from Go

The closest model is "Go, but with **one goroutine and no `select`**." Every
function runs on the same scheduler stack. The only way to "go" something is
to start a Promise (`somePromise()` without `await`) and remember to handle
its rejection later. There are real Worker Threads (`node:worker_threads`)
for CPU offload, but they're message-passing-only — not a substitute for
goroutines, more like `os/exec` with shared memory disabled.

### Practical implications in this repo

- The NATS subscriber uses an `for await (const msg of sub)` loop. Each
  iteration awaits the next message — the loop *suspends* between events
  rather than busy-spinning.
- Postgres queries via Prisma are async. Connection pool size matters; the
  default is 2× CPU cores. Plenty for this service.
- We don't ever do synchronous JSON parsing of payloads we can't trust
  (DoS surface). `JSONCodec` from `nats.js` decodes for us; if we ever take
  user JSON of unbounded size we'd parse in chunks.

---

## 3. TypeScript essentials

TypeScript is a **compile-time** type layer on top of JavaScript. At runtime
the types are erased — `node` executes plain JS in `dist/`, and the type
checker is just a build-time tool. This has consequences:

- Type assertions (`value as Foo`) are unchecked at runtime. If you lie, the
  runtime won't notice — you'll get an undefined-method error later.
- Generic constraints disappear after compile. There's no `is_a?(Foo)`
  equivalent unless you write a **type guard** function.

### Strict mode (we have it on)

```json
// tsconfig.json
"strict": true
```

Enables `strictNullChecks`, `noImplicitAny`, and friends. Practical effect:

- `string | undefined` is not assignable to `string`. You handle the absent
  case or use a non-null assertion (`!`) when you can prove it can't happen.
- Untyped function parameters are a compile error.

### Structural typing

```ts
type HasSlug = { slug: string };

function greet(s: HasSlug) { console.log(s.slug); }

greet({ slug: 'francesc', extra: 42 });  // OK — structural match
```

Coming from Ruby / Elixir, this is "duck typing the compiler can prove."
Coming from Go, it's "interfaces, but inferred automatically from object
shape — you don't `implements` anything."

### Discriminated unions

Used heavily for NATS payload variants in v2 work:

```ts
type PortfolioPayload = { version: 2; slug: string; holdings: Holding[] };
type RadarPayload     = { version: 1; slug: string; stocks: Stock[] };
type PricePayload     = { symbol: string; price: number; currency: string };

type AnyPayload = PortfolioPayload | RadarPayload | PricePayload;

function handle(p: AnyPayload) {
  if ('holdings' in p) {
    // TypeScript knows p is PortfolioPayload here
  }
}
```

### `unknown` vs `any`

`any` is "turn off the type checker for this value." Avoid.
`unknown` is "I don't know the type — narrow before use." Always prefer
`unknown` for boundary inputs (NATS messages, request bodies, env vars).

We use Zod (see `src/config/env.schema.ts`) to parse `unknown` into a typed
shape at runtime — same pattern as Phoenix's `Ecto.Changeset.cast/4` or
Rails' strong parameters.

---

## 4. NestJS architecture

NestJS is the Spring Boot / Phoenix / Rails of the Node world. It gives you:

- **Modules** — units of grouping (`AppModule`, `EventsModule`, `NatsModule`).
- **Providers** — the things modules expose (services, repositories,
  middlewares).
- **Controllers** — HTTP routes (`@Controller('events')` + `@Get()`).
- **Guards / Pipes / Interceptors / Filters** — chainable middlewares with
  declared roles.
- **A DI container** — class instances are injected by type, like Spring.

### File layout in this repo

```
src/
├── main.ts                 # app bootstrap (like Rails' config/application.rb)
├── app.module.ts           # root composition module
├── config/                 # @nestjs/config + Zod validator
├── prisma/                 # PrismaClient as a Nest provider
├── events/                 # domain: insert + query + HTTP
├── nats/                   # NATS subscriber service
├── auth/                   # ApiKeyGuard
└── health/                 # /healthz
```

### Coming from Rails

Each NestJS *module* is roughly an isolated mini-engine. Within a module you
have *services* (POROs / service objects), *controllers* (`ActionController`
subclasses), and *DTOs* (strong parameters as classes). The DI container is
the bit that doesn't exist in Rails: you list a service in a module's
`providers` and Nest will instantiate it once and pass it to anyone that
declares it in their constructor.

A guard like `ApiKeyGuard` is a `before_action :require_api_key` — but
declared structurally with `@UseGuards(ApiKeyGuard)` on the controller.

### Coming from Phoenix

Modules ≈ OTP applications, but the supervision tree is implicit (Nest
manages the lifecycle for you via `OnModuleInit` / `OnModuleDestroy` hooks).
Providers ≈ named GenServers, except you reference them by class, not by
registered name. Guards ≈ Plug pipelines.

Phoenix's "context" pattern is essentially what a NestJS module is: a folder
that owns its domain (`events/`) and exposes a service to the rest of the
app.

### Coming from Go

Closest in spirit to Uber's `fx` or Google's `wire` DI frameworks. If you've
used `gin` + manual wiring, NestJS feels heavy at first — there's no `func
NewEventsService(db *gorm.DB) *EventsService { ... }`. Instead the framework
finds the dependency by class identity. Annoying until you remember why DI
exists: trivial testability (`Test.createTestingModule(...).overrideProvider(...)`).

### Decorators

Decorators (`@Injectable()`, `@Get()`, `@UseGuards()`) are TypeScript syntax
for what would be macros in Elixir or annotations in Java. They're plain
functions that mutate class metadata. Required if you use NestJS — there is
no decorator-free API.

---

## 5. Prisma vs ActiveRecord / Ecto / database/sql

Prisma is the most-used ORM in production Node apps. It's **schema-first**:
you write your tables in `prisma/schema.prisma`, run `npx prisma migrate dev`,
and Prisma generates a typed client.

### What `prisma generate` produces

A typed `PrismaClient` class with `prisma.event.create({...})`,
`prisma.event.findMany({...})`, etc. Every method's argument and return type
is generated from your schema. Autocomplete works everywhere.

### Coming from ActiveRecord

- Models are not classes you can subclass. There is no `Event.where(...)`
  — you call `prisma.event.findMany({ where: { ... } })`.
- No callbacks (`before_save`, etc.). Hooks happen in service layer code.
- Validations live in DTOs (class-validator) at the controller boundary, not
  on the model.
- Associations are explicit in the schema and you have to opt into eager
  loading via `include: { ... }`.

The migration workflow is the bit that maps best: `prisma migrate dev` is
`bin/rails db:migrate` with `--name` baked in. Migrations live in
`prisma/migrations/<timestamp>_<slug>/migration.sql`.

### Coming from Ecto

- The schema-first model is closer to Ecto than to ActiveRecord.
- Changesets don't exist — validation is at the DTO layer with
  class-validator decorators (`@IsString()`, `@IsInt()`).
- Repos: there's effectively one `PrismaClient` (≈ `Repo`), and queries hang
  off table accessors (`prisma.event`, `prisma.user`).

### Coming from `database/sql` + sqlc

The closest Go analogue is **sqlc** (generated typed queries) or **ent**
(schema-first). Prisma is more like ent. If you're attached to writing raw
SQL, Prisma has `prisma.$queryRaw\`SELECT ...\`` with tagged-template
parameter binding.

### Transactions

```ts
await prisma.$transaction(async (tx) => {
  await tx.event.create({ data: ... });
  await tx.event.update({ where: ..., data: ... });
});
```

We don't use them in v1 — single inserts. We'd add them when v2 introduces
rollup writes that must be atomic with raw-event writes.

---

## 6. NATS integration — `nats.js` directly

We use the official `nats` package directly, *not* `@nestjs/microservices`'s
NATS transport. Why:

- `@nestjs/microservices` is shaped for **request/reply with reply subjects**
  and a Nest-specific message envelope (`{ pattern, data }`). Quantic emits
  raw JSON on plain subjects (e.g. `prod.portfolio.updated`).
- Subject *wildcards* — `*.portfolio.updated` — work clumsily with the Nest
  transport's `@EventPattern` decorator, which expects exact subjects.
- Plain `nats.js` is small and idiomatic; using it teaches you the actual
  NATS API, which transfers to other languages.

### The subscriber loop

```ts
const sub = this.connection.subscribe('*.portfolio.updated');
for await (const msg of sub) {
  await this.handle(msg.subject, msg.data);
}
```

`for await (...)` is JavaScript's async iterator syntax. Each iteration
*suspends* the function until the next message arrives — efficient, no
busy-poll.

Coming from Elixir: this is a `Stream.each` that's actually a `GenServer`'s
mailbox. Coming from Go: `for msg := range sub.C { ... }` on a channel.

### Plain pub/sub vs JetStream

NATS has two modes:

- **Plain pub/sub** (what we use) — fire-and-forget, ephemeral, no replay.
  Subscribers must be online to receive messages.
- **JetStream** — durable, stream-based, ack/replay semantics. The NATS
  equivalent of Kafka.

The Quantic ↔ Pulse bus is plain pub/sub by design (low ops overhead,
in-memory Pulse fits the model). Trends inherits the same shape, with the
trade-off that **events fired while Trends is down are gone**. v6 of the
roadmap migrates to JetStream durable consumers so cold-start can replay.

### Reconnect semantics

`nats.js` reconnects automatically by default. We configure
`maxReconnectAttempts: -1` (forever) and `reconnectTimeWait: 2000` (every 2s)
in `NatsService.onModuleInit`. Subscriptions are auto-restored on reconnect.

### Coming from Pulse (Elixir)

Side-by-side:

```elixir
# Pulse (lib/pulse/nats/consumer.ex roughly)
{:ok, _sid} = Gnat.sub(conn, self(), "#{env}.portfolio.updated")

def handle_info({:msg, %{subject: subject, body: body}}, state) do
  payload = Jason.decode!(body)
  ...
end
```

```ts
// Trends (src/nats/nats.service.ts)
const sub = this.connection.subscribe(`${env}.portfolio.updated`);
for await (const msg of sub) {
  const payload = JSONCodec().decode(msg.data);
  ...
}
```

Identical concepts, syntactic skin only.

---

## 7. Async, errors, and the promise model

### Promises

A `Promise<T>` is the JS equivalent of `Task<T>` / `Future<T>`. It can be
*pending*, *fulfilled*, or *rejected*. `await` on a promise blocks the
current async function until it settles.

```ts
const result = await fetch('https://example.com/');
```

### `async` function = "this function returns a Promise"

Inside an `async` function you can `await` other promises. Outside one, you
have to use `.then(...)` / `.catch(...)`.

### Errors

A *rejected* promise behaves like a thrown exception when awaited:

```ts
try {
  await this.events.record(...);
} catch (err) {
  this.logger.error(`Failed: ${(err as Error).message}`);
}
```

**Unhandled rejections crash the process** (since Node 15). This is correct
behaviour — you want a fast crash + restart instead of a zombie. Kamal will
restart the container.

### The big footgun: don't forget `await`

```ts
this.events.record(...);  // BUG: returns a Promise; if it rejects, your process dies
await this.events.record(...);  // correct
```

ESLint's `@typescript-eslint/no-floating-promises` rule catches this — we
have it on. Coming from Go, this is "you called the function but forgot
`go` *and* forgot to handle the error." Coming from Elixir, "you sent a
message but didn't pattern-match the reply."

### Nest exception filters

When a service throws inside an HTTP handler, Nest's default exception filter
maps known exceptions (`UnauthorizedException`, `BadRequestException`) to
HTTP status codes (401, 400). Unknown errors → 500. The guard in
`src/auth/api-key.guard.ts` throws `UnauthorizedException` rather than
returning false explicitly because Nest's translation is nicer than a bare
boolean.

---

## 8. Testing

**Jest** is the runner (industry default for Node). Tests live next to source
as `*.spec.ts` for unit tests, and in `test/*.e2e-spec.ts` for end-to-end.

### Unit tests

`src/events/events.service.spec.ts` shows the pattern:

- Build a Nest testing module with the real `EventsService` and a mocked
  `PrismaService`.
- Call the service methods, assert on the mock.

Coming from Rails: this is RSpec with the `:request` spec scope replaced by
a typed mock. Coming from Phoenix: ExUnit + mock-via-behaviour.

### E2E tests

`test/app.e2e-spec.ts` boots a full Nest app, connects to a real NATS + real
Postgres (started by docker-compose locally; by GHA's `services:` block in
CI), publishes a message, asserts the HTTP read endpoint returns it.

This is the test that catches integration bugs — wrong subject parsing,
missing index, payload field names. Worth more than 50 controller mocks.

### Running them

```sh
npm test            # unit
npm run test:e2e    # requires docker-compose running
```

CI runs both on every push.

---

## 9. Build & deploy

### The build pipeline

1. `tsc` (driven by `nest build`) compiles `src/*.ts` → `dist/*.js`.
2. `npx prisma generate` writes the typed client into `node_modules/.prisma/client/`.
3. Runtime is `node dist/main.js` — plain Node, no transpiler in production.

### The Dockerfile

Multi-stage:

- **Stage 1 (`builder`)**: `node:22-alpine` with everything — devDependencies,
  source code. Runs `prisma generate`, `npm run build`, then
  `npm prune --omit=dev`.
- **Stage 2 (`runtime`)**: `node:22-alpine` with just `tini` added. Copies
  `node_modules` (prod-only), `dist/`, `prisma/`, manifests. Runs as a
  non-root user.

Image is built for **arm64** to match the Hetzner host.

### Migrations on start

The entrypoint:

```sh
npx prisma migrate deploy && node dist/main.js
```

`prisma migrate deploy` is idempotent — it only applies *pending*
migrations. Safe to run on every container start. This is the equivalent of
`bin/rails db:migrate` in the Rails Dockerfile or `Ecto.Migrator.run/4` in
release-bound Elixir.

### Kamal

Same model as the sibling services. `config/deploy.yml` defines:

- The app container (`trends`).
- A **Postgres accessory** — Kamal manages a dedicated `postgres:16-alpine`
  container with its own volume, only reachable on the docker network.
- Health check on `/healthz`.

Secrets are pulled from a **Bitwarden Secure Note** at deploy time by the
`kamal-secrets bitwarden` adapter — see `.kamal/secrets`. The same pattern
runs in CI (`.github/workflows/deploy.yml` does `bw login` + `bw unlock`
before invoking `kamal deploy`).

### Coming from Phoenix releases

`mix release` ≈ `npm run build` + Docker. Kamal handles the deploy itself
(zero-downtime swap, health checks) — there's no `kamal release` you have to
build by hand the way you might assemble a `mix release` recipe.

---

## 10. Observability & privacy

Trends ships with a **Grafana** Kamal accessory for ops dashboards. The
provisioning lives in `grafana/` and is mounted into the container via
`files:` in `config/deploy.yml`:

- `grafana/provisioning/datasources/postgres.yaml` — connects to Postgres
  via the least-privilege `grafana_reader` role, with env-var interpolation
  for the password.
- `grafana/provisioning/dashboards/default.yaml` — tells Grafana to load
  any JSON in `/var/lib/grafana/dashboards/`.
- `grafana/dashboards/trends-overview.json` — sample "Trends — Operations"
  dashboard. Edit it via the Grafana UI; the file watcher reloads on save
  in dev workflows (we don't auto-write back to the file system, so commit
  exports of any dashboards worth keeping).
- `grafana/setup.sql` — one-time SQL to create the `grafana_reader` role
  with the password from Bitwarden. Apply via
  `kamal accessory exec postgres --reuse 'psql ...' < grafana/setup.sql`
  after first deploy.

### Privacy boundary (read this twice)

Trends ingests per-user data: portfolio holdings, radar target prices, opt-in
slugs. The **only** trust boundary that ever exposes that data to end users
is a planned **first-party aggregation API** (`GET /aggregations/...`,
v3 on the roadmap) which:

- Quantic calls server-side (never the browser directly).
- Returns pre-anonymized aggregates — "average YoC across the community",
  "top 10 most-held tickers" — never per-user payloads.
- Lives inside Trends itself, so the privacy rules are enforced by the same
  team that owns the data.

**Grafana is NOT that API.** It's operator-only — even though Grafana is
published at `https://grafana.quantic.es` for browser access, it's gated
by Grafana's own login (anonymous off, signups off, brute-force lockout
on, read-only Postgres role under the hood). Dashboards may freely query
slugs to debug ingestion problems — only the logged-in operator sees them.
The rule is "no slug ever ends up rendered on a Quantic page via Grafana
— no public links, no embeds." We rely on Grafana's auth layer plus the
operator's discipline, not on cryptographic guarantees.

Coming from Rails: think of it as a "two-tier read API" — internal admin
panel (Grafana) vs public API (the planned `/aggregations/...`). Same data,
two surfaces, different controls.

### Why no Prometheus yet

The plan defers Prometheus / `/metrics` endpoint to v2. Reasoning: we have
no production traffic to measure, no incidents to debug, and a clear
upgrade path (`@willsoto/nestjs-prometheus` + a Prometheus accessory pointing
the same Grafana datasource list at it). Premature instrumentation
generates dashboards nobody reads.

When the time comes, the canonical metrics are: HTTP request rate / p95
latency / 5xx ratio (app), NATS subscription lag and reconnect count
(consumer), Prisma query duration (DB). All emitted via the prometheus
exporter, all visualized in Grafana alongside the existing event-volume
panels.

---

## 11. Glossary & toolchain

| Term | Meaning |
|------|---------|
| `package.json` | Project manifest — dependencies, scripts (≈ `Gemfile` + `Rakefile`, or `mix.exs`). |
| `package-lock.json` | Resolved dependency tree (`Gemfile.lock` / `mix.lock`). Commit it. |
| `npm ci` | Strict install from lockfile, for CI/Docker. `npm install` may modify the lockfile; `npm ci` will not. |
| `npm run <name>` | Runs a script from `package.json`'s `"scripts"` section. |
| `tsconfig.json` | TypeScript compiler config. |
| `tsconfig.build.json` | A second config that excludes tests during `nest build`. |
| `nest-cli.json` | NestJS CLI config (sets `sourceRoot`, etc.). |
| `node_modules/` | Installed dependencies (never commit). |
| `dist/` | Compiled JS output (never commit). |
| `pnpm` / `yarn` | Alternative package managers. We use `npm` for simplicity. |
| ESM vs CJS | Two module systems in Node. We target **CommonJS** (`require`) — what NestJS defaults to. ESM (`import`) is the newer style but introduces footguns we don't need yet. |
| `tsx` / `ts-node` | Run a `.ts` file without precompiling. We use `ts-node` for `scripts/publish-fake.ts`. Not used in production. |
| `tini` | Tiny init in our runtime image — reaps zombies, forwards signals. |
| `BigInt` | Native JS arbitrary-precision integer type. Prisma uses it for `BIGINT` columns; not JSON-serializable by default (see `main.ts`). |
| Decorators | Syntax for "attach metadata to this class/method." Required by NestJS. |
| Promise vs Observable | NestJS supports both. We stick to Promises (more familiar, simpler). |

### Useful commands cheat sheet

```sh
# Setup
npm ci
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
npx prisma migrate dev

# Develop
npm run dev                      # nest start --watch
npm run publish:fake portfolio   # emit a fake NATS event

# Validate
npm run lint
npm test
npm run test:e2e
npm run build

# Operate (production)
kamal deploy
kamal app logs -f
kamal app exec --interactive --reuse "node"     # node REPL inside container
```

---

## Where to go next

- Read `src/nats/nats.service.ts` end to end — it's the densest 80 lines of
  the codebase and exercises every concept above.
- Read `src/events/events.service.ts` for the Prisma usage pattern.
- Skim `prisma/schema.prisma` to see the database surface.
- For the broader ecosystem context, see the CLAUDE.md files in
  `dividend-portfolio`, `pulse`, and `logo-service`.
