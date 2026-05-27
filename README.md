# Trends

Time-series analytics consumer for the Quantic ecosystem. Trends subscribes to
the NATS bus that Quantic and Pulse share, stores every portfolio / radar /
stock-price event as a raw snapshot in Postgres, and exposes a read API for
historical queries.

Where Pulse holds *current* state in memory, Trends holds *history* on disk.

Built with **NestJS** + **TypeScript** + **Prisma** + **PostgreSQL** + **NATS**.

> If you're new to Node/TypeScript and coming from Ruby/Elixir/Go, start with
> [`docs/TECH.md`](docs/TECH.md) — it explains the stack from your perspective.

## Services Architecture

```
                              Internet
                                 |
        +----------+----------+----------+----------+
        |          |          |          |          |
   quantic.es  pulse.q.es  logos.q.es trends.q.es grafana.q.es
        |          |          |          |          |
    +---+------+ +-+----+ +---+----+ +---+----+ +---+----+
    | Rails    | |Pulse | |Logo    | |Trends  | |Grafana |
    |          | |Phoen.| |Service | |(this)  | |        |
    | - Auth   | |LiveV.| |  Go    | |NestJS  | | ops    |
    | - Radar  | |      | |        | |+ TS    | | dash-  |
    | - Hold.  | |- Pub | |- Logo  | |        | | boards |
    | - Plan   | |  por.| |  pipe  | |- NATS  | | only   |
    | - AI     | |- Com.| |- SQLi  | |  sub.  | |        |
    +-----+----+ +-+----+ +--------+ |- Hist  | +---+----+
          |        |                 |  query |     |
          |        |                 |  API   |     | (reads
          |        |                 +---+----+     |  via
          |        |                     |          |  grafana
          |        |                     v          |  _reader,
          |        |                  +--+-----+    |  read-only
          |        |                  |Postgres|<---+  role)
          |        |                  | accessory|
          +---+ +--+                  +--------+
              | |
          +---+-+----+
          |   NATS   |
          | plain    |
          | pub/sub  |
          +----------+
```

**Rails App** (`quantic.es`) — the main user-facing app. Auth, stock radar with target prices, holdings, buy plan, dividend calendar, and AI-powered insights via Google Gemini. **Publishes** events to NATS when portfolio/radar data changes. See [dividend-portfolio repo](https://github.com/fleveque/dividend-portfolio).

**Pulse** (`pulse.quantic.es`) — Elixir/Phoenix LiveView. **Subscribes** to NATS, serves public portfolio pages + a real-time community dashboard. No database — current state held in DETS + in-memory via GenServers. See [pulse repo](https://github.com/fleveque/pulse).

**Logo Service** (`logos.quantic.es`) — Go service. Resolves stock ticker symbols to PNG logos (filesystem + SQLite cache, GitHub source repos, LLM fallback). HTTP-only, no NATS. See [logo-service repo](https://github.com/fleveque/logo-service).

**Trends** (`trends.quantic.es`) — this repo. NestJS + TypeScript. **Subscribes** to the same NATS subjects as Pulse, but persists every event as a raw snapshot in PostgreSQL. Where Pulse holds *current* state in memory, Trends holds *history* on disk. `GET /events` exposes the event log to operators (X-API-Key auth).

**Grafana** (`grafana.quantic.es`) — operator-only dashboards (event volumes, ingestion lag, DB size). Co-located with Trends as a Kamal accessory; reads Postgres via a read-only `grafana_reader` role. **Privacy boundary**: never exposes individual user data — see "Observability" below.

**NATS** — lightweight messaging server (~10MB RAM), single Docker container on the same VPS as everything else (`dividend-portfolio-nats:4222` on the Kamal docker network). **Plain pub/sub**, NOT JetStream — messages are dropped if no subscriber is connected, so deploy ordering matters (consumer before publisher when adding new subjects). Environment isolation via subject prefixes (`prod.`, `beta.`, `dev.`).

### NATS Event Flow

```
Rails publishes on holding/radar/opt-in/out changes + stock price refresh:

  {env}.portfolio.updated     {version: 2, slug, base_currency,
                                holdings: [{symbol, currency, quantity,
                                            avg_price, price, value_in_base,
                                            value_in_usd}, ...],
                                stats: {yoc, currentYield, sectors}}
  {env}.portfolio.opted_in    full portfolio snapshot (same shape)
  {env}.portfolio.opted_out   {slug}
  {env}.radar.updated         {version: 1, slug, base_currency, stocks: [...]}
  {env}.radar.opted_in        full radar snapshot
  {env}.radar.opted_out       {slug}
  {env}.stock.price_updated   {symbol, price, currency, updated_at}

Pulse  -> updates GenServer state -> pushes to LiveView via PubSub
Trends -> persists raw payload to Postgres -> queryable via GET /events
```

Pulse and Trends are siblings on the same bus — both subscribe to the same subjects, but they keep different shapes of state for different purposes. Adding a new subject means shipping the consumer (Pulse and/or Trends) **before** the publisher (Quantic), or the first burst is lost.



## What it does today (v1)

- Subscribes to:
  - `*.portfolio.updated`, `*.portfolio.opted_in`
  - `*.radar.updated`, `*.radar.opted_in`
  - `*.stock.price_updated`
- Persists each message as one row in an `events` table with a JSONB payload.
- Exposes `GET /events` for time-range queries by `kind` + `key`.
- Plain pub/sub — no JetStream. Matches the Quantic ↔ Pulse bus.

Out of scope for v1 (intentionally — see [the plan](../../.claude/plans/i-want-to-learn-hazy-hejlsberg.md)):
charts UI, rollups, alerts, AI prompt feeds, WebSockets, durable consumers.

## Quick start

Prereqs: Node 22+, Docker, npm.

```sh
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
npm install
npx prisma migrate dev          # first time only
npm run dev
```

Trends will be listening on `http://localhost:3000`.

### Exercise the pipeline

In another terminal:

```sh
npm run publish:fake portfolio          # publishes a fake dev.portfolio.updated
npm run publish:fake radar              # or radar / price

curl -H "X-API-Key: dev-key-change-me" \
  'http://localhost:3000/events?kind=portfolio&key=fake-portfolio&limit=5'
```

## API

### `GET /events`

Reads historical events. Authenticated via `X-API-Key` header.

| Param   | Required | Default      | Notes |
|---------|----------|--------------|-------|
| `kind`  | yes      |              | `portfolio` \| `radar` \| `price` |
| `key`   | yes      |              | Portfolio slug (for `portfolio`/`radar`) or stock symbol (for `price`) |
| `from`  | no       | `now - 7d`   | ISO 8601 |
| `to`    | no       | `now`        | ISO 8601 |
| `limit` | no       | `500`        | Max `5000` |

Response:

```json
{
  "events": [
    { "occurred_at": "2026-05-27T10:00:00.000Z", "payload": { /* raw NATS payload */ } }
  ],
  "next_cursor": null
}
```

`next_cursor` is the `occurred_at` of the last returned row when more pages
exist. Pass it as `to=<cursor>` for the next page (events are returned newest
first).

### `GET /healthz`

No auth. Returns `{"status":"ok"}`. Kamal-proxy hits this every 30s.

## Environment

See [`.env.example`](.env.example) for the full list. The validator in
`src/config/env.schema.ts` rejects boot with a clear error if anything is
missing or malformed.

## Tests

```sh
npm test            # unit tests
npm run test:e2e    # end-to-end (needs docker-compose running)
```

## Observability

Trends ships with a **Grafana** accessory (`grafana/grafana:11.3.0`) for
operational dashboards. A sample "Trends — Operations" dashboard is
provisioned automatically with panels for:

- Total events ingested (24h)
- Ingestion lag (now − last `occurred_at`)
- Distinct portfolios tracked
- DB size
- Events per hour by kind (stacked bars)
- Top 10 stock symbols by price events
- Events by env

### Privacy boundary — read this before adding dashboards

Grafana is for **operational and aggregate** metrics only. Individual user
data (slugs as labels, payload contents, holdings, target prices) **never
appears in Grafana**. Aggregations across users that we eventually expose
publicly will go through a dedicated **Trends API** (planned for v3) that
Quantic calls server-side — not directly through the visualization layer.

Defense in depth: Grafana connects with a least-privilege `grafana_reader`
Postgres role. Set it up once after first deploy:

```sh
# Pick a strong password and store it in Bitwarden as TRENDS_GRAFANA_READER_PASSWORD.
# Then apply the SQL:
kamal accessory exec postgres --reuse \
  "psql -U trends -d trends -v password='$TRENDS_GRAFANA_READER_PASSWORD' -f -" \
  < grafana/setup.sql
```

### Accessing Grafana

Grafana is exposed at **https://grafana.quantic.es**. kamal-proxy terminates
TLS via Let's Encrypt and forwards to the accessory container.

Login: `admin` / value of `TRENDS_GRAFANA_ADMIN_PASSWORD` from Bitwarden.

Security posture (be honest with yourself before exposing this to the
internet):

- The admin password is the *entire* control surface between strangers and
  the dashboard. Keep it long and unique. Rotate it if it ever leaks.
- Anonymous access: **off** (`GF_AUTH_ANONYMOUS_ENABLED=false`).
- Signups: **off** (`GF_USERS_ALLOW_SIGN_UP=false`).
- Brute-force lockout: on by default in Grafana v11 — 5 failed logins per
  username triggers a temporary ban.
- Grafana's datasource uses the **read-only** `grafana_reader` Postgres role
  — even if someone gets in, they can't write.
- The privacy boundary above still applies: dashboards visible to logged-in
  operators are fine to show slugs / payload details for debugging, but
  **never link a dashboard publicly** or embed a panel on Quantic. Public
  cross-user aggregations belong to the v3 first-party API.

**DNS prerequisite**: before the first `kamal deploy`, add an `A` record
`grafana.quantic.es → 46.224.239.228` at your DNS provider. Otherwise
Let's Encrypt's challenge fails and you'll hit a self-signed cert warning.

## Deploy

Kamal v2 to the same Hetzner host as Quantic / Pulse / Logos.

```sh
kamal setup       # first time only — provisions Postgres accessory + app
kamal deploy
```

Secrets come from Bitwarden via the kamal-secrets adapter (see
[`.kamal/secrets`](.kamal/secrets)). Production keys live in the
`quantic-prod` Secure Note as:

- `KAMAL_REGISTRY_PASSWORD`
- `TRENDS_API_KEYS`
- `TRENDS_DATABASE_URL`
- `TRENDS_POSTGRES_PASSWORD`
- `TRENDS_GRAFANA_ADMIN_PASSWORD`
- `TRENDS_GRAFANA_READER_PASSWORD`

## Roadmap (not yet — see `../.claude/plans/`)

- v2: continuous rollups (daily portfolio value, YoC over time).
- v3: **first-party aggregation API** (`GET /aggregations/...`) that Quantic
  calls server-side to surface community-wide insights on user-facing pages.
  This is the *only* surface where cross-user data flows out of Trends, and
  it does anonymization at the API boundary, not at the viz layer.
- v4: AI prompt-context digest endpoint.
- v5: alerts published back onto NATS.
- v6: JetStream durable consumers for cold-start replay.
