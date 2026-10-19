# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace server

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3001 WEB_DIR=/app/web/dist
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
