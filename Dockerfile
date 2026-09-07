# Multi-stage Dockerfile for unified single-port AiFiqh application
FROM oven/bun:1.4.0 AS builder

WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock tsconfig.base.json biome.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source trees
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
COPY apps/api ./apps/api
COPY db ./db
COPY scripts ./scripts

# Build frontend and shared packages
RUN bun run build

# ----------------------------------------------------------------------------
# Runner stage
# ----------------------------------------------------------------------------
FROM oven/bun:1.4.0 AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy node_modules and built assets
COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/db ./db
COPY --from=builder /app/scripts ./scripts
COPY docker/entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
