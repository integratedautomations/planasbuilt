FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace server
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
ENV DATA_DIR=/data PORT=3001 WEB_DIR=/app/web/dist
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
