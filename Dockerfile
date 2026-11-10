FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

RUN npm install -g pnpm@12.16.1

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY src ./src
COPY assets ./assets

# MCP_HOST must be 0.0.0.0 inside a container — the 127.0.0.1 default only
# works for local runs. MCP_PORT/MCP_AUTH_TOKEN/DEEZER_REFRESH_TOKEN are set in Coolify.
ENV MCP_HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:${MCP_PORT:-3000}/health || exit 1

CMD ["node", "src/index.ts"]
