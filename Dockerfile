FROM node:24-bookworm-slim AS build
WORKDIR /app
# Only the build image needs compilers if SQLite has no matching prebuilt binary.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/dialogue/package.json ./packages/dialogue/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
COPY packages/contracts/ ./packages/contracts/
COPY packages/dialogue/ ./packages/dialogue/
COPY apps/server/ ./apps/server/
COPY apps/web/ ./apps/web/
COPY tests/e2e/ ./tests/e2e/
COPY tests/dialogue-fixtures/ ./tests/dialogue-fixtures/
ARG VITE_MOCK=true
RUN VITE_MOCK=${VITE_MOCK} npm run build

FROM build AS production
RUN npm prune --omit=dev --offline --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production /app/node_modules/ ./node_modules/
COPY --from=production /app/packages/contracts/ ./packages/contracts/
COPY --from=production /app/packages/dialogue/ ./packages/dialogue/
COPY --from=production /app/apps/server/ ./apps/server/
COPY --from=build /app/apps/web/dist/ ./apps/web/dist/
RUN mkdir /data /run/zeus-secrets && chown node:node /data /run/zeus-secrets && chmod 700 /data /run/zeus-secrets
USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CALLMATE_API_PORT||3000)+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]

# Optional subscription-backed development engine; credentials are supplied at runtime only.
FROM node:24-bookworm-slim AS codex-cli
RUN npm install --global --prefix /opt/codex @openai/codex@0.163.0 && npm cache clean --force
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM runtime AS runtime-codex
USER root
COPY --from=codex-cli /opt/codex/ /opt/codex/
COPY --from=codex-cli /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV PATH="/opt/codex/bin:${PATH}" CODEX_HOME=/codex SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
RUN mkdir /codex && chown node:node /codex && chmod 700 /codex
USER node
