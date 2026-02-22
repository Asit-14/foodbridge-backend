# ── Stage 1: Install dependencies ───────────────────
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: Production image ──────────────────────
FROM node:20-alpine

RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

USER app

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/health || exit 1

CMD ["node", "server.js"]
