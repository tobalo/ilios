# Use official Bun image
FROM oven/bun:1.2-slim AS base
WORKDIR /app

# Install dependencies
FROM base AS install
RUN mkdir -p /temp/prod
COPY package.json /temp/prod/
RUN cd /temp/prod && bun install --production

# Copy source and build
FROM base AS build
COPY --from=install /temp/prod/node_modules node_modules
COPY . .

# Create data directory with proper permissions
RUN mkdir -p /app/data/tmp && chmod -R 777 /app/data

# Production image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=build /app/src src
COPY --from=build /app/package.json .
COPY --from=build /app/drizzle.config.ts .
COPY --from=build /app/data data

# Ensure migrations are available
RUN test -d /app/src/db/migrations || echo "Warning: migrations directory not found"

# Ensure data directory is writable (will be replaced by volume mount in Railway)
RUN mkdir -p /data/tmp && chmod -R 777 /data

# Set default database path to volume mount location
ENV LOCAL_DB_PATH=/data/ilios.db
ENV PORT=1337

# Run as non-root user for security
USER bun
EXPOSE 1337/tcp

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:1337').then(() => process.exit(0)).catch(() => process.exit(1))"

ENTRYPOINT ["bun", "run", "start"]
