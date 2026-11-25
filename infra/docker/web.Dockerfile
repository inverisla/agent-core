# The web app (Next.js standalone server). Build from the repo root:
#   docker build -f infra/docker/web.Dockerfile -t agentcore-web .
FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/blocks/package.json packages/blocks/
COPY packages/testing/package.json packages/testing/
# An optional extra CA, only for building behind a TLS-inspecting proxy.
RUN --mount=type=secret,id=ca,required=false \
    NODE_EXTRA_CA_CERTS=$([ -f /run/secrets/ca ] && echo /run/secrets/ca) \
    pnpm install --frozen-lockfile --filter @agent-core/web...
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN NEXT_OUTPUT=standalone pnpm --filter @agent-core/web build

FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# Files stay owned by root: the app can read its code but not change it. Only Next.js's
# cache folder is writable.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# The logo and other static files: standalone output leaves public/ out.
COPY --from=build /repo/apps/web/public ./apps/web/public
# The agent definitions: uploads record the agent and version from these (task 7).
COPY agents ./agents
ENV AGENTS_DIR=/app/agents
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
