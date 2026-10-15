FROM node:24-bookworm-slim AS build
WORKDIR /app
# Only the build image needs compilers if SQLite has no matching prebuilt binary.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
COPY packages/contracts/ ./packages/contracts/
COPY apps/server/ ./apps/server/
COPY apps/web/ ./apps/web/
COPY tests/e2e/ ./tests/e2e/
RUN npm run build

FROM build AS production
RUN npm prune --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production /app/node_modules/ ./node_modules/
COPY --from=production /app/packages/contracts/ ./packages/contracts/
COPY --from=production /app/apps/server/ ./apps/server/
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CALLMATE_API_PORT||3000)+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
