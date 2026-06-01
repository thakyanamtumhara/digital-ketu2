FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock* ./
COPY prisma ./prisma

RUN bun install

COPY . .

# Generate Prisma client
RUN bun run db:generate

# Build dashboard frontend
RUN bun run build

EXPOSE 3000

# Enable pgvector + run migrations, then ALWAYS start the server.
# A dead DB (e.g. Neon suspended on quota) must NOT block boot — otherwise the
# container restart-loops silently and the outage lasts for days. With ';' the
# server always starts and serves /api/health, so monitoring can detect a DB outage
# instead of the whole service vanishing. The app re-connects when the DB returns.
CMD ["sh", "-c", "echo 'CREATE EXTENSION IF NOT EXISTS vector;' | bunx prisma db execute --url \"$DATABASE_URL\" --stdin 2>/dev/null || true; bunx prisma db push --skip-generate || echo '[boot] prisma db push failed (DB may be down) — starting server anyway'; bun run start"]
