# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN python3 -m venv /app/.venv \
  && /app/.venv/bin/pip install --no-cache-dir -U pip \
  && /app/.venv/bin/pip install --no-cache-dir -r requirements.txt

COPY index.html ./
COPY public ./public
COPY src ./src
COPY rag ./rag

ENV NODE_ENV=production \
    PORT=3847 \
    DATA_DIR=/data \
    PYTHON_BIN=/app/.venv/bin/python \
    PATH=/app/.venv/bin:/usr/local/bin:/usr/bin:/bin

RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 3847

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3847)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
