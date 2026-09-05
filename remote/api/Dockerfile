FROM oven/bun:1.4.0-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
COPY apps/auth-api/package.json ./apps/auth-api/package.json
COPY packages/brand/package.json ./packages/brand/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/logging/package.json ./packages/logging/package.json
COPY packages/team-client/package.json ./packages/team-client/package.json
COPY remote/api/package.json ./remote/api/package.json
RUN bun install --production --ignore-scripts --frozen-lockfile --filter @openbot/remote-api

FROM oven/bun:1.4.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/remote/api/node_modules ./remote/api/node_modules
COPY remote/api ./remote/api
USER bun
WORKDIR /app/remote/api
EXPOSE 8443
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD bun -e 'const r=await fetch("http://127.0.0.1:8080/health/ready");process.exit(r.ok?0:1)'
ENTRYPOINT ["bun", "src/index.ts"]
