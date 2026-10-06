# Tour Scout: Next.js standalone server + the official Qloo harness (the event's supported surface).
# Secrets are never baked in: pass QLOO_API_KEY, CLAUDE_API_KEY (and optionally GEMINI_API_KEY) at runtime.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data \
    QLOO_BASE_URL=https://hackathon.api.qloo.com \
    QLOO_TRUSTED_BASE_URL=https://hackathon.api.qloo.com \
    LLM_PROVIDER=claude
# The app spawns `qloo exec` / `qloo api`; pin the harness version the adapters were verified against.
RUN npm install --global @qloo/qloo-harness@0.1.26 && npm cache clean --force && qloo --version
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# /data holds share-link snapshots, the daily LLM budget counter and the geocoding cache.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
