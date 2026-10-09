# Slotlock server image: `slotlock serve` (MCP and A2A over HTTP) on Node.js 22 LTS.
#   docker build -t slotlock .
#   docker compose up            (PostgreSQL included; see docker-compose.yml and the README)
# Every base image is pinned by digest; Dependabot proposes updates. The server listens on
# 0.0.0.0:8080 inside the container: publish it on 127.0.0.1, or behind a TLS reverse proxy.

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
# .dockerignore admits only what the build reads.
COPY . .
RUN npm run build && chmod 0755 dist/cli.js

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies exactly as locked: the libraries plus postgres, the peer dependency.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/dist ./dist
# The server never runs a package manager, so the image ships none.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
  && ln -s /app/dist/cli.js /usr/local/bin/slotlock
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
# The base image's unprivileged `node` user, numerically so `runAsNonRoot` can verify it.
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=6s --start-period=30s --retries=3 CMD ["slotlock", "healthcheck"]
ENTRYPOINT ["slotlock"]
CMD ["serve"]

LABEL org.opencontainers.image.title="Slotlock" \
      org.opencontainers.image.description="Calendar and availability engine for AI agents, served over MCP and A2A" \
      org.opencontainers.image.source="https://github.com/PILOTAAI/slotlock" \
      org.opencontainers.image.url="https://slotlock.pylota.io" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="TREFT LTD" \
      io.modelcontextprotocol.server.name="io.github.PILOTAAI/slotlock"
