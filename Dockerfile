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

# Enable pgvector, run migrations, then start server
CMD ["sh", "-c", "echo 'CREATE EXTENSION IF NOT EXISTS vector;' | bunx prisma db execute --url \"$DATABASE_URL\" --stdin 2>/dev/null || true; bunx prisma db push --skip-generate && bun run start"]
