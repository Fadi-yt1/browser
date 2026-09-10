# All-in-one gateway image: built frontend + orchestrator in a single container.
# It talks to the host Docker daemon to start and stop session containers.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS server
WORKDIR /srv
COPY server/package.json ./
RUN npm install --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/public
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=server /srv/dist ./dist
COPY --from=web /web/dist ./public
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
