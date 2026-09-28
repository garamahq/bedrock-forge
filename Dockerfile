# ─── Stage 1: dependencies ───────────────────────────────────────────────────
# Pin the exact pnpm version so corepack doesn't hit the network every build.
FROM node:22-alpine AS deps
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# Copy workspace manifests first for layer-cache efficiency.
COPY pnpm-workspace.yaml .npmrc package.json pnpm-lock.yaml ./
COPY apps/api/package.json    ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json    ./apps/web/
COPY packages/shared/package.json          ./packages/shared/
COPY packages/remote-executor/package.json ./packages/remote-executor/
COPY prisma/schema.prisma ./prisma/
COPY prisma.config.js ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─── Stage 2: builder ────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .

# Generate Prisma client (prisma.config.js handles missing DATABASE_URL gracefully)
# Separate RUN layers = better Docker cache:
#   prisma schema change → only invalidates from generate onward
#   src change           → only invalidates from turbo build onward
RUN pnpm exec prisma generate

# Build shared package first — guarantees dist/index.d.ts exists for downstream
RUN pnpm --filter @bedrock-forge/shared build

# Build API, Worker, and Web bundles
RUN pnpm turbo build \
      --filter=@bedrock-forge/api \
      --filter=@bedrock-forge/worker \
      --filter=@bedrock-forge/web

# Compile seed script for runtime use (outputs prisma/seed.js)
RUN node_modules/.bin/tsc \
      --module commonjs \
      --target ES2022 \
      --esModuleInterop true \
      --resolveJsonModule true \
      --skipLibCheck true \
      --rootDir prisma \
      --outDir prisma \
      prisma/seed.ts

# Prune dev dependencies: remove node_modules and do a clean production-only
# install via the BuildKit cache. This fully purges the local virtual store of
# all devDependencies (TypeScript, Jest, webpack, etc.) because pnpm installs
# into its content-addressed store at /pnpm/store, so a fresh --prod install
# will only link the production subset. pnpm prune cannot do this because the
# .pnpm virtual store entries remain even after prune.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    rm -rf node_modules && \
    pnpm install --prod --frozen-lockfile && \
    pnpm exec prisma generate

# ─── Stage 3: runtime (API + Worker) ─────────────────────────────────────────
# Do NOT install corepack/pnpm here — the runtime only needs Node.js + the
# compiled dist files and the pruned node_modules from the builder stage.
FROM node:22-alpine AS runtime

ARG INSTALL_CHROMIUM=true
ENV MSGPACKR_NATIVE_ACCELERATION_DISABLED=true

# rclone  — Google Drive backup uploads
# whois   — domain WHOIS lookups
# postgresql-client — pg_dump for Forge self-backup
# chromium — invoice PDF generation and local Lighthouse audits
RUN apk add --no-cache rclone whois postgresql-client && \
    if [ "$INSTALL_CHROMIUM" = "true" ]; then apk add --no-cache chromium; fi && \
    mkdir -p /home/node/.config/rclone && \
    chown -R node:node /home/node/.config && \
    mkdir -p /tmp/forge-backups /tmp/forge-system-backups && \
    chown node:node /tmp/forge-backups /tmp/forge-system-backups

WORKDIR /app
USER node

# Root node_modules (shared tooling: prisma CLI for migrations, etc.)
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Compiled application bundles
COPY --from=builder --chown=node:node /app/apps/api/dist    ./apps/api/dist
COPY --from=builder --chown=node:node /app/apps/worker/dist ./apps/worker/dist

# Per-app node_modules (only what survived the production install)
COPY --from=builder --chown=node:node /app/apps/api/node_modules    ./apps/api/node_modules
COPY --from=builder --chown=node:node /app/apps/worker/node_modules ./apps/worker/node_modules

# Shared packages — only dist + package.json (no src, no tests)
COPY --from=builder --chown=node:node /app/packages/shared/dist           ./packages/shared/dist
COPY --from=builder --chown=node:node /app/packages/shared/package.json   ./packages/shared/package.json
COPY --from=builder --chown=node:node /app/packages/remote-executor/dist  ./packages/remote-executor/dist
COPY --from=builder --chown=node:node /app/packages/remote-executor/package.json ./packages/remote-executor/package.json
COPY --from=builder --chown=node:node /app/packages/remote-executor/node_modules ./packages/remote-executor/node_modules

# Prisma — schema + compiled seed + generated client (already in node_modules)
COPY --from=builder --chown=node:node /app/prisma        ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.js ./prisma.config.js

# Worker shell scripts
COPY --from=builder --chown=node:node /app/apps/worker/scripts ./apps/worker/scripts

COPY --chown=node:node entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=10s \
  CMD node -e "const http=require('http'); const checks=['http://localhost:3000/health','http://localhost:3001/health']; Promise.all(checks.map(url=>new Promise((resolve,reject)=>{ const req=http.get(url,res=>{ res.resume(); res.statusCode>=200&&res.statusCode<300 ? resolve() : reject(new Error(url+' -> '+res.statusCode)); }); req.setTimeout(3000,()=>{req.destroy(new Error(url+' timeout'));}); req.on('error',reject); }))).then(()=>process.exit(0),err=>{ console.error(err.message); process.exit(1); });"

CMD ["./entrypoint.sh"]

# ─── Stage 4: web (nginx serving React SPA) ──────────────────────────────────
FROM nginx:1.27-alpine AS web

RUN chown -R nginx:nginx /var/cache/nginx /var/log/nginx /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && \
    chown nginx:nginx /var/run/nginx.pid

USER nginx

COPY --chown=nginx:nginx --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY --chown=nginx:nginx nginx/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO /dev/null http://localhost:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
