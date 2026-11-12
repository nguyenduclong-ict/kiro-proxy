FROM node:24.22.2-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=20197 \
    DB_PATH=/app/data/kiro-proxy.sqlite

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 20197
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:20197/ || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
