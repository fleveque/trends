# Multi-stage Dockerfile for trends.
#
# Node note (for Ruby/Elixir/Go folks): `npm ci` is the production-friendly
# equivalent of `bundle install --deployment` — it reads package-lock.json and
# refuses to drift. `--omit=dev` skips devDependencies (tsc, jest, eslint, …)
# which we don't need at runtime because the build stage already produced
# plain JavaScript in `dist/`.

# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Copy lockfile + manifest first — Docker caches this layer so dependency
# installs only re-run when those files change, not on every code edit.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# Copy the rest of the source and build.
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npx prisma generate
RUN npm run build

# Prune dev dependencies so we copy only what the runtime needs.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini: tiny init that reaps zombies and forwards signals so SIGTERM from
#       Docker actually closes our DB/NATS connections cleanly.
RUN apk add --no-cache tini

# Non-root runtime user (matches the pattern in dividend-portfolio + logo-service).
RUN addgroup -S app && adduser -S -G app app

WORKDIR /app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/package*.json ./

USER app

EXPOSE 3000

ENV NODE_ENV=production

# Run pending migrations against the live DB before booting the app.
# `prisma migrate deploy` is idempotent — applies pending migrations only.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
