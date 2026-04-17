FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ packages/
COPY web/ web/

RUN npm ci --no-audit --no-fund && npm run build

# ── Runtime ──────────────────────────────────────────────────
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-yaml git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages packages/
COPY --from=builder /app/web/dist web/dist/
COPY package.json tsconfig.base.json ./
COPY scripts/ scripts/
COPY phases/ phases/
COPY references/ references/
COPY templates/ templates/
COPY .cursor/agents/ .cursor/agents/
COPY .cursor/skills/ .cursor/skills/
COPY SKILL.md AGENTS.md README.md ./

ENV NODE_ENV=production
ENV PIPELINE_ORCHESTRATOR_HOME=/app
ENV PIPELINE_SESSIONS_DIR=/data/sessions
ENV PIPELINE_SERVER_PORT=18000

EXPOSE 18000

VOLUME ["/data/sessions"]

CMD ["node", "packages/server/dist/main.js"]
