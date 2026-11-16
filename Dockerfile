FROM node:26-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --frozen-lockfile

FROM node:26-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/newrelic.cjs ./

ENV HOME=/tmp \
    NPM_CONFIG_CACHE=/tmp/.npm

USER appuser

EXPOSE 3000

ENV NODE_OPTIONS="-r newrelic"

CMD ["node", "dist/server.js"]
