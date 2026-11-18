# API + worker image. Build from the repository root:
#   docker build -f server/Dockerfile -t slotwise-api .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY engine/package.json engine/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev -w server -w engine

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY engine ./engine
COPY server ./server
WORKDIR /app/server
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "src/index.js"]
