# Production image for the API. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t paint-api .
# Runs `node dist/server/main.js` as a non-root user on port 3000.

ARG NODE_IMAGE=node:24-alpine

# ---- build: install the API's workspace, bundle it, keep only production deps ----
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /repo

# Manifests first, so dependency layers are reused while only source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/observability/package.json packages/observability/
COPY packages/shared/package.json packages/shared/
COPY packages/testing/package.json packages/testing/
COPY packages/ui/package.json packages/ui/
COPY packages/ops/package.json packages/ops/
RUN pnpm install --frozen-lockfile --filter @paint/api...

COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/db packages/db
COPY packages/observability packages/observability
COPY packages/shared packages/shared
RUN pnpm --filter @paint/api build

# A self-contained copy of the API package with production dependencies only.
RUN pnpm --filter @paint/api deploy --prod --legacy /out \
 && cp -R apps/api/dist /out/dist \
 && rm -rf /out/src /out/tsconfig.json /out/vite.config.ts /out/Dockerfile

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
# The package managers are not needed at runtime: less to patch, less to exploit.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Amazon RDS certificate authorities, so DATABASE_URL can use sslmode=verify-full.
RUN wget -qO /usr/local/share/rds-ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
 && chmod 644 /usr/local/share/rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/rds-ca.pem
COPY --from=build --chown=root:root /out ./
# The built-in "node" user (uid 1000); the app files stay owned by root and read-only to it.
USER node
EXPOSE 3000
# ECS and the load balancer have their own checks; this one serves `docker run` and compose.
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Node is PID 1 and handles SIGTERM itself (graceful shutdown in the app).
CMD ["node", "--enable-source-maps", "dist/server/main.js"]
