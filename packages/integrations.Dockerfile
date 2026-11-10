# Slotlock integrations image (RFC 0004 P3): slotlock-sync, slotlock-notify and
# slotlock-payments-stripe, each run as a process of its own from this one image.
#   docker build -f packages/integrations.Dockerfile -t slotlock-integrations .
#   docker run --env-file sync.env slotlock-integrations slotlock-sync serve
# Base images are pinned by digest, as the server image's are. slotlock itself is installed beside
# the packages (node_modules/slotlock), so the sync reads iCalendar URLs with its parser.

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
# packages/integrations.Dockerfile.dockerignore admits only what the build reads.
COPY . .
RUN npm run build \
  && for package in sync notify payments-stripe; do \
       (cd "packages/$package" && ../../node_modules/.bin/tsc -p tsconfig.build.json) || exit 1; \
     done

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies exactly as locked, postgres among them.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/dist ./node_modules/slotlock
COPY --from=build /src/packages/sync/package.json ./packages/sync/package.json
COPY --from=build /src/packages/sync/dist ./packages/sync/dist
COPY --from=build /src/packages/notify/package.json ./packages/notify/package.json
COPY --from=build /src/packages/notify/dist ./packages/notify/dist
COPY --from=build /src/packages/payments-stripe/package.json ./packages/payments-stripe/package.json
COPY --from=build /src/packages/payments-stripe/dist ./packages/payments-stripe/dist
# Nothing here runs a package manager, so the image ships none.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
  && chmod 0755 packages/sync/dist/bin.js packages/notify/dist/bin.js packages/payments-stripe/dist/bin.js \
  && ln -s /app/packages/sync/dist/bin.js /usr/local/bin/slotlock-sync \
  && ln -s /app/packages/notify/dist/bin.js /usr/local/bin/slotlock-notify \
  && ln -s /app/packages/payments-stripe/dist/bin.js /usr/local/bin/slotlock-payments-stripe
ENV NODE_ENV=production \
    HOST=0.0.0.0
# The base image's unprivileged `node` user, numerically so `runAsNonRoot` can verify it.
USER 1000:1000
EXPOSE 8090 8091 8092
CMD ["slotlock-sync", "serve"]

LABEL org.opencontainers.image.title="Slotlock integrations" \
      org.opencontainers.image.description="Calendar sync, notifications and Stripe payments for Slotlock, each its own process" \
      org.opencontainers.image.source="https://github.com/PILOTAAI/slotlock" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="TREFT LTD"
