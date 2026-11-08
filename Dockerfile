FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DTEK_BROWSER_STATE_FILE=/app/artifacts/.dtek-browser-state.json \
    TZ=Europe/Kyiv

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh \
    && mkdir -p artifacts .cache \
    && chown node:node artifacts .cache

USER node

ENTRYPOINT ["/app/docker-entrypoint.sh"]
