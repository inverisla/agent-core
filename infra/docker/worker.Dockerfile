# The Temporal worker, which also runs the deploy-time database setup:
#   docker build -f infra/docker/worker.Dockerfile -t agentcore-worker .
#   worker:  node apps/worker/src/main.ts   (default)
#   migrate: node packages/db/src/deploy-cli.ts
# Node runs the TypeScript directly; the workspace layout is kept so workspace
# packages resolve to their source, not into node_modules.
FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
# System root certificates, which the slim image lacks: Temporal's native client reads
# these (not Node's bundled copy) to check Temporal Cloud's TLS certificate. Checked in CI
# by tls-check.mjs. Don't set SSL_CERT_FILE: it replaces this path.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/blocks/package.json packages/blocks/
COPY packages/testing/package.json packages/testing/
# An optional extra CA, only for building behind a TLS-inspecting proxy.
RUN --mount=type=secret,id=ca,required=false \
    NODE_EXTRA_CA_CERTS=$([ -f /run/secrets/ca ] && echo /run/secrets/ca) \
    pnpm install --frozen-lockfile --prod --filter @agent-core/worker...
COPY tsconfig.base.json ./
COPY packages/db ./packages/db
COPY packages/core ./packages/core
COPY packages/blocks ./packages/blocks
COPY packages/testing ./packages/testing
COPY apps/worker ./apps/worker
# The agent definitions: the worker loads them at start and runs only the recorded version.
COPY agents ./agents
ENV AGENTS_DIR=/app/agents
# The demo agent's test set (invented sample contracts), which the worker runs once for
# each new agent version for the operator console (task 16). Other agents keep theirs in
# their own tests/ folder, copied with agents/.
COPY samples/files ./samples/files
COPY samples/expected ./samples/expected
# Files stay owned by root: the app can read its code but not change it.
USER node
CMD ["node", "apps/worker/src/main.ts"]
