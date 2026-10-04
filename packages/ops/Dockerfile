# Image for one-off operations tasks inside the VPC: database migrations on deploy
# (node src/migrate-cli.ts) and the backup restore drill
# (node src/restore-drill-cli.ts, docs/runbooks/restore.md). Build from the repository root:
#   docker build -f packages/ops/Dockerfile -t paint-ops .
# Runs `node src/restore-drill-cli.ts` (Node strips the TypeScript types) with
# pg_dump/pg_restore 17 from Alpine.

ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/observability/package.json packages/observability/
COPY packages/shared/package.json packages/shared/
COPY packages/testing/package.json packages/testing/
COPY packages/ui/package.json packages/ui/
COPY packages/ops/package.json packages/ops/
RUN pnpm install --frozen-lockfile --prod --filter @paint/ops
COPY packages/ops packages/ops
RUN pnpm --filter @paint/ops deploy --prod --legacy /out \
 && rm -rf /out/src/*.test.ts /out/Dockerfile /out/tsconfig.json
# The migrations of this commit, for the one-off migration task (src/migrate-cli.ts).
COPY packages/db/migrations /out/migrations

FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache postgresql17-client \
 && wget -qO /usr/local/share/rds-ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
 && chmod 644 /usr/local/share/rds-ca.pem
# TLS to RDS is verified against Amazon's CAs, by Node (pg) and by libpq (pg_dump).
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/rds-ca.pem \
    PGSSLROOTCERT=/usr/local/share/rds-ca.pem \
    DRILL_TOOLS=local \
    TMPDIR=/tmp
WORKDIR /app
COPY --from=build --chown=root:root /out ./
USER node
CMD ["node", "src/restore-drill-cli.ts"]
