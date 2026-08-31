FROM oven/bun:1.3.11-alpine AS dependencies
WORKDIR /app/remote/api
COPY remote/api/package.json ./
RUN bun install --production --ignore-scripts

FROM oven/bun:1.3.11-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/remote/api/node_modules ./node_modules
COPY remote/api ./remote/api
USER bun
WORKDIR /app/remote/api
EXPOSE 8443
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD bun -e 'const r=await fetch("http://127.0.0.1:8080/health/ready");process.exit(r.ok?0:1)'
ENTRYPOINT ["bun", "src/index.ts"]
