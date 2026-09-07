#!/bin/sh
set -e

echo "==> AiFiqh Unified Container Starting..."

# Wait for PostgreSQL
echo "==> Waiting for database to be ready..."
until bun -e "
import postgres from 'postgres'
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://aifiqh:aifiqh@db:5432/aifiqh', { timeout: 3 })
await sql\`select 1\`
await sql.end({ timeout: 1 })
" 2>/dev/null; do
  echo "    waiting for postgres..."
  sleep 2
done
echo "==> Database is ready!"

# Apply migrations
echo "==> Applying database migrations..."
bun scripts/migrate.ts

# Seed initial catalog if needed
echo "==> Seeding database..."
bun scripts/seed.ts || true

# Start unified server (serves both API and Web SPA on a single port)
echo "==> Starting AiFiqh Unified Server on port ${PORT:-3000}..."
exec bun apps/api/src/index.ts
