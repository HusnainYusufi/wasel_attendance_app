# syntax=docker/dockerfile:1.7
#
# Wasel Attendance API — production image.
#
# Debian slim rather than Alpine on purpose: `argon2` is a native module, and
# musl has no prebuilt binaries for it. On Alpine every build would compile it
# from source (python3, make, g++ in the image, minutes per build) or — worse —
# silently fall back to a slower JS implementation. glibc gets a prebuild.

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Manifests first, so a source-only change reuses the cached install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/api/package.json ./apps/api/
# apps/api's postinstall runs `prisma generate`, which needs the schema present.
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/prisma.config.ts ./apps/api/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api

RUN pnpm --filter @wasel/contracts build \
    && pnpm --filter @wasel/api build

# ---------------------------------------------------------------------------
# Stage 2 — production dependencies only
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/api/package.json ./apps/api/
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/prisma.config.ts ./apps/api/

# `prisma generate` runs here via postinstall. It needs no DATABASE_URL — the
# config attaches a datasource only when one is present — so the image builds
# without any database secret baked in or required.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

# tini reaps zombies and forwards SIGTERM to node, which is what makes the
# graceful-shutdown path (drain in-flight requests, close the Prisma pool)
# actually run instead of the container being SIGKILLed out from under it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Dependency tree, including the generated Prisma client and the pnpm symlinks
# that make `@wasel/contracts` resolve.
COPY --from=deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=deps --chown=node:node /repo/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps --chown=node:node /repo/apps/api/node_modules ./apps/api/node_modules

COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node packages/contracts/package.json ./packages/contracts/
COPY --from=builder --chown=node:node /repo/packages/contracts/dist ./packages/contracts/dist

COPY --chown=node:node apps/api/package.json apps/api/prisma.config.ts ./apps/api/
COPY --chown=node:node apps/api/prisma ./apps/api/prisma
COPY --from=builder --chown=node:node /repo/apps/api/dist ./apps/api/dist

# Run unprivileged. `node` (uid 1000) ships with the base image; ownership was
# set on each COPY above rather than with a `chown -R`, which would rewrite every
# file's metadata and store a second full copy of node_modules as a new layer.
USER node

WORKDIR /repo/apps/api

EXPOSE 3000

# Uses the app's own readiness probe, so an unreachable database marks the
# container unhealthy rather than letting it sit there serving 500s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
