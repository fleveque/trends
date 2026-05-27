# Trends — context for Claude

You are working on **Trends**, the fourth microservice in the Quantic
ecosystem (alongside dividend-portfolio in Rails, pulse in Elixir, logo-service
in Go). Trends is a NestJS + TypeScript service that subscribes to the shared
NATS bus and stores time-series snapshots of portfolio, radar, and stock-price
events in Postgres.

This repo is also a **learning project** for the user — they have deep Ruby /
Elixir / Go experience but are new to Node/TS. Bias your explanations toward
mental-model bridges from those stacks, and don't reach for trendy/niche
libraries when an industry-standard one will do the same job.

## Architecture in one diagram

```
              ┌──────────┐                       ┌──────────┐
Quantic ────► │  NATS    │ ──► Pulse (Elixir)    │  Logos   │ ◄── HTTP from Quantic
(Rails)       │ (pub/sub)│ ──► Trends (NestJS)   │   (Go)   │
              └──────────┘     │                 └──────────┘
                               ▼
                          ┌──────────┐
                          │ Postgres │
                          └──────────┘
                               ▲
                               │  GET /events
                               │  X-API-Key
```

- NATS subjects use a `{env}.` prefix — `prod.`, `beta.`, `dev.`. Same on all services.
- The bus is **plain pub/sub** (NOT JetStream). Messages dropped if no
  subscriber is connected — relevant for deploy ordering (see project memory).

## Tech stack rationale

- **NestJS** — DI/modules/decorators map cleanly to Rails idioms. Within the
  Node world it's one of the two dominant backend frameworks (alongside
  bare Express/Fastify).
- **Prisma** — most-used Node ORM in industry. Schema-first migrations.
- **`nats.js` directly** (not `@nestjs/microservices`) — the official Nest NATS
  transport assumes request/reply envelopes and exact-subject matching, which
  doesn't fit Quantic's plain-subject wildcard publishes.
- **Postgres + JSONB** — Quantic adds fields to payloads often; JSONB avoids
  schema churn on the consumer.
- **Kamal v2** — same deploy model as siblings; co-located on the Hetzner VPS.

## Conventions to follow

- TypeScript strict mode is on. Prefer `unknown` over `any`. Use Zod for
  external input validation (envs already, expand to NATS payloads when we
  start typing them per subject).
- Don't add comments that just describe what the code does. Comment only when
  the **why** is non-obvious.
- Migrations: edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <slug>`. Never edit migration SQL by hand.
- Tests live next to the source as `*.spec.ts` (unit) or in `test/*.e2e-spec.ts` (e2e).

## Critical files to know about

- `src/nats/nats.service.ts` — the subscriber loop. Bug source #1 if events
  stop landing in the DB.
- `src/nats/subject.ts` — maps subjects to `kind` and which payload field
  carries the natural `key`. Update here when Quantic adds a new event type.
- `src/events/events.service.ts` — insert + query. The shape of the API.
- `prisma/schema.prisma` — single source of truth for the DB schema.
- `config/deploy.yml` — Kamal config. Mirror logo-service patterns when
  changing.

## Privacy guardrail (load-bearing)

Trends stores per-user portfolio and radar snapshots. The trust boundary is:

- **Grafana** (Kamal accessory, public at `https://grafana.quantic.es` behind kamal-proxy TLS) sees only **aggregate / operational** metrics — counts, rates, lag, DB size, stock-symbol popularity. The admin password is the entire access-control surface from the internet — keep it strong (Bitwarden: `TRENDS_GRAFANA_ADMIN_PASSWORD`). Grafana's datasource uses a read-only `grafana_reader` Postgres role; even if someone gets in, they can't write. Dashboards visible to logged-in operators may show slugs/payloads for debugging — but never link a dashboard publicly or embed a panel on Quantic.
- **Cross-user aggregations** destined for end-user exposure flow through a planned **first-party Trends API** (v3 — `GET /aggregations/...`) that Quantic calls server-side. Anonymization happens at the API boundary.
- **The raw `GET /events` endpoint** is operator-only (X-API-Key from `TRENDS_API_KEYS`). Never proxied to end users.
- Postgres has a least-privilege `grafana_reader` role created via `grafana/setup.sql` — defense in depth.

If a feature would put user data into a public-adjacent surface (Grafana panel exposed via URL, public REST endpoint returning slugs, etc.), **push back and confirm before building**.

## Out-of-scope guardrails (per the plan)

Do NOT add (unless the user explicitly asks):
- Rollups / aggregation tables — those come in v2.
- Alerts / notifications — v5.
- Dashboards / charts UI — v4.
- AI prompt feeds — v3.
- JetStream / durable consumers — v6.

If a feature request touches one of these, push back and confirm before
expanding scope. The user's auto-memory captures a hard preference for
minimal v1 cuts.

## Ecosystem-wide gotchas

- **NATS deploy order**: consumer before publisher. If you add a new subject
  to Quantic that Trends should record, ship Trends first or the first burst
  of messages will be lost.
- **No code shared with siblings** — services communicate by NATS or HTTP, never
  via shared libraries or DBs.

See [`docs/TECH.md`](docs/TECH.md) for a deeper walkthrough of the stack and
why each choice was made.
