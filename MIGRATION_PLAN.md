# Neon → Railway Postgres Migration Plan

**Status:** REVIEW ONLY — Do NOT execute without Ankit present.  
**Why:** Neon free tier (100 CU-hours/month) keeps running out at end of billing cycle.  
Railway Postgres (included in your existing Railway subscription) has no compute-hour limit.  
**Risk:** Low — Neon stays fully intact during migration. Rollback is one env var change.

---

## Pre-Flight Checklist

- [ ] Railway project open in browser: https://railway.app
- [ ] Neon console open: https://console.neon.tech
- [ ] This doc open for copy-pasting commands
- [ ] Service currently healthy (HTTP 200 from /api/health)
- [ ] `pg_dump` installed locally (`which pg_dump` — usually comes with PostgreSQL client)

---

## Step 1: Add Railway Postgres Plugin

1. Open your Railway project dashboard
2. Click **+ New** → **Database** → **PostgreSQL**
3. Railway will provision a new Postgres instance in the same project
4. Click the new Postgres service → **Variables** tab
5. Copy the `DATABASE_URL` value — you'll need it in Step 4

> Railway Postgres supports pgvector via the `pgvector` extension. We'll enable it in Step 2.

---

## Step 2: Enable pgvector on Railway Postgres

Connect to the new Railway Postgres database (use Railway's built-in shell or `psql`):

```sql
-- Enable pgvector extension (required for vector(1024) columns)
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify it loaded
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
-- Expected: vector | 0.7.x (or current version)
```

**CRITICAL:** If this fails, Railway Postgres may not support pgvector.
Check Railway docs or contact support before proceeding.

---

## Step 3: Export from Neon

Get your Neon `DATABASE_URL` from Railway environment variables (current value).

```bash
# Set variables for convenience
NEON_URL="<your-current-DATABASE_URL-from-Neon>"
RAILWAY_URL="<new-Railway-Postgres-DATABASE_URL-from-Step-1>"

# Export — exclude owner/privilege statements so import works on any user
pg_dump \
  --no-owner \
  --no-acl \
  --format=custom \
  --compress=9 \
  --file=ketu_backup_$(date +%Y%m%d).dump \
  "$NEON_URL"

# Verify dump file exists and has reasonable size (should be several MB)
ls -lh ketu_backup_*.dump
```

> `--format=custom` produces a binary dump that's faster to restore and supports selective restore.  
> `--compress=9` reduces file size significantly for large embedding data.

---

## Step 4: Import to Railway Postgres

```bash
pg_restore \
  --no-owner \
  --no-acl \
  --jobs=4 \
  --dbname="$RAILWAY_URL" \
  ketu_backup_$(date +%Y%m%d).dump

# Watch for errors in output. Most "already exists" warnings are safe to ignore.
# Real errors look like: ERROR: relation "..." already exists (and isn't a warning)
```

---

## Step 5: Verify Vector Embeddings Migrated Intact

Run these queries against Railway Postgres BEFORE switching:

```sql
-- 1. Total chunk count (should match Neon)
SELECT COUNT(*) AS total_chunks FROM "KnowledgeChunk";

-- 2. Embedding coverage (should match total — all chunks must have embeddings)
SELECT COUNT(*) AS chunks_with_embedding FROM "KnowledgeChunk" WHERE embedding IS NOT NULL;

-- 3. Breakdown by source (compare against Neon baseline)
SELECT source, COUNT(*) AS count FROM "KnowledgeChunk" GROUP BY source ORDER BY source;
-- Expected sources: CATALOG, CORRECTION, FAQ, POLICY, PREMIUM_PAIR, SAVED_REPLY, STYLE_GUIDE, STYLE_PAIR

-- 4. Verify vector column type is preserved (not NULL or wrong type)
SELECT id, source, title, 
       pg_typeof(embedding) AS embedding_type,
       vector_dims(embedding) AS dims   -- should be 1024 (Voyage AI dimension)
FROM "KnowledgeChunk"
WHERE embedding IS NOT NULL
LIMIT 5;

-- 5. Check DeferToKetu table (also has vector column)
SELECT COUNT(*) AS total,
       COUNT(embedding) AS with_embedding
FROM "DeferToKetu";

-- 6. Check ManualReplyPair table (no vectors, but important for learning pipeline)
SELECT COUNT(*) AS total_pairs,
       COUNT(reviewedAt) AS reviewed_pairs,
       COUNT(*) - COUNT(reviewedAt) AS pending_review
FROM "ManualReplyPair";
```

**Baseline numbers from Neon (as of last healthy state):**
- KnowledgeChunk total: ~845+ rows
- KnowledgeChunk with embedding: should equal total (100% coverage)
- DeferToKetu: check `/api/learning/stats` for current count

---

## Step 6: Test Vector Search on Railway Postgres

After import but BEFORE switching DATABASE_URL, run a manual vector search to confirm embeddings work:

```sql
-- This requires you to have a test embedding vector.
-- Easiest way: temporarily point a local dev instance at Railway Postgres,
-- then call: GET /api/knowledge/chunks?source=CORRECTION&pageSize=3
-- If it returns results with content, vector search works.

-- Alternatively, verify the operator exists:
SELECT '[1,2,3]'::vector <=> '[1,2,4]'::vector AS cosine_distance;
-- Should return a decimal number, not an error
```

---

## Step 7: Switch DATABASE_URL on Railway

1. Open Railway dashboard → your **digital-ketu2** service (not the new Postgres service)
2. **Variables** tab → find `DATABASE_URL`
3. Replace the Neon URL with the Railway Postgres URL from Step 1
4. Click **Save** — Railway will automatically redeploy

```
# What you're changing:
BEFORE: postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
AFTER:  postgresql://postgres:xxx@xxx.railway.internal:5432/railway
```

---

## Step 8: Post-Switch Verification

After Railway redeploys (~90 seconds):

```bash
# 1. Health check
curl -s "https://digital-ketu2-production.up.railway.app/api/health"

# 2. Knowledge stats (critical — must show all chunks with embeddings)
curl -s "https://digital-ketu2-production.up.railway.app/api/knowledge/stats"
# Verify: total ~845+, withEmbedding == total

# 3. Verify all chunk sources return data (vector search working)
curl -s "https://digital-ketu2-production.up.railway.app/api/knowledge/chunks?source=CORRECTION&pageSize=3"
curl -s "https://digital-ketu2-production.up.railway.app/api/knowledge/chunks?source=PREMIUM_PAIR&pageSize=3"
curl -s "https://digital-ketu2-production.up.railway.app/api/knowledge/chunks?source=STYLE_PAIR&pageSize=3"
curl -s "https://digital-ketu2-production.up.railway.app/api/knowledge/chunks?source=CATALOG&pageSize=3"

# 4. Embeddings status
curl -s "https://digital-ketu2-production.up.railway.app/api/embeddings/status"
# Verify: voyageConfigured: true

# 5. Learning stats
curl -s "https://digital-ketu2-production.up.railway.app/api/learning/stats"
```

---

## Rollback Plan

Railway redeploy with old Neon URL takes ~90 seconds. Neon data is NOT touched during migration.

```
To rollback:
1. Railway dashboard → digital-ketu2 service → Variables
2. Change DATABASE_URL back to the Neon URL
3. Save → redeploy happens automatically (~90s)
4. Verify /api/health returns 200
```

**Keep the Neon connection string saved somewhere safe until you've confirmed Railway Postgres is stable for at least one full billing cycle.**

---

## Notes

- The `prisma db push` command does NOT need to be re-run — schema is already defined and  
  pg_restore will have restored all tables, indexes, and data.
- If Prisma migrations (not `db push`) were used, restore will handle those too via the  
  `_prisma_migrations` table being dumped.
- Railway Postgres runs on the same Railway project so internal networking (`railway.internal`)  
  will be used for the DATABASE_URL — this is faster than Neon's external connection.
- The `vector(1024)` column type requires pgvector ≥ 0.5.0. Railway's managed Postgres  
  typically ships a recent version — verify in Step 2.

---

*Plan prepared: 2026-06-01. Execute with Ankit present, following steps in order.*
