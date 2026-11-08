# --- build stage: has the compilers some packages (better-sqlite3) need when no prebuilt binary fits ---
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- runtime stage: small image, no compilers ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data HOST=0.0.0.0 PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data && chmod +x scripts/docker-entrypoint.sh
# No "USER node" here: the entrypoint fixes ownership of a host-mounted disk, then switches to "node" (never runs the app as root).
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
