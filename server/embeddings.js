// Embedding generation and vector search using Voyage AI + pgvector
//
// Voyage AI is Anthropic's recommended embedding model.
// - Model: voyage-3 (1024 dimensions — matches our pgvector schema)
// - Cost: $0.06 per 1M tokens (~$0.000003 per defer check)
// - Quality: Real semantic understanding (not word hashing)
//
// Requires VOYAGE_API_KEY environment variable.
// If not set, falls back to basic word-hash (low quality).

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY
const VOYAGE_MODEL = 'voyage-3'  // 1024 dimensions, matches vector(1024) in schema

/**
 * Generate embedding for a text string using Voyage AI
 * Falls back to basic word-hash if VOYAGE_API_KEY is not set
 */
export async function getEmbedding(anthropic, text) {
  if (VOYAGE_API_KEY) {
    return getVoyageEmbedding(text)
  }
  console.warn('[Embedding] VOYAGE_API_KEY not set — using basic word-hash (low quality)')
  return textToSimpleEmbedding(text)
}

/**
 * Generate real AI embedding using Voyage AI API
 */
async function getVoyageEmbedding(text) {
  const response = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text],
      input_type: 'query',
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    console.error(`[Voyage AI] API error: ${response.status} — ${err}`)
    // Fall back to hash-based if Voyage fails
    return textToSimpleEmbedding(text)
  }

  const data = await response.json()
  const embedding = data.data[0].embedding

  // Log token usage for monitoring
  if (data.usage) {
    console.log(`[Voyage AI] ${data.usage.total_tokens} tokens used for embedding`)
  }

  return `[${embedding.join(',')}]`
}

/**
 * Fallback: Simple text-to-embedding using character frequency hashing
 * Only used when VOYAGE_API_KEY is not configured
 */
function textToSimpleEmbedding(text) {
  const normalized = text.toLowerCase().trim()
  const words = normalized.split(/\s+/)
  const dim = 1024
  const vec = new Float32Array(dim)

  for (const word of words) {
    let hash = 0
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0
    }
    const idx = Math.abs(hash) % dim
    vec[idx] += 1.0
  }

  let magnitude = 0
  for (let i = 0; i < dim; i++) magnitude += vec[i] * vec[i]
  magnitude = Math.sqrt(magnitude)
  if (magnitude > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= magnitude
  }

  return `[${Array.from(vec).join(',')}]`
}

/**
 * Search knowledge base chunks by vector similarity
 */
export async function vectorSearch(db, anthropic, queryText, { limit = 5, minSimilarity = 0.0 } = {}) {
  const embedding = await getEmbedding(anthropic, queryText)

  const results = await db.$queryRaw`
    SELECT
      id,
      source,
      "sourceId",
      title,
      content,
      metadata,
      1 - (embedding <=> ${embedding}::vector) as similarity
    FROM "KnowledgeChunk"
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${embedding}::vector
    LIMIT ${limit}
  `

  return results.filter(r => r.similarity >= minSimilarity)
}

/**
 * Search the Defer to Ketu list for similar questions
 * With Voyage AI embeddings, threshold 0.80 works well for semantic matching
 * (hash-based needed 0.85+ because it was just word overlap)
 */
export async function vectorSearchDeferList(db, anthropic, queryText, { threshold = 0.80 } = {}) {
  const embedding = await getEmbedding(anthropic, queryText)

  const results = await db.$queryRaw`
    SELECT
      id,
      "buyerQuestion",
      "correctReply",
      1 - (embedding <=> ${embedding}::vector) as similarity
    FROM "DeferToKetu"
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> ${embedding}::vector) >= ${threshold}
    ORDER BY embedding <=> ${embedding}::vector
    LIMIT 1
  `

  return results.length > 0 ? results[0] : null
}

/**
 * Re-embed all existing Defer-to-Ketu items with Voyage AI
 * Call this once after adding VOYAGE_API_KEY to regenerate all embeddings
 */
export async function reEmbedAllDeferItems(db, anthropic) {
  if (!VOYAGE_API_KEY) {
    return { status: 'skipped', reason: 'VOYAGE_API_KEY not configured' }
  }

  const items = await db.deferToKetu.findMany({
    select: { id: true, buyerQuestion: true },
  })

  let updated = 0
  let failed = 0

  for (const item of items) {
    try {
      const embedding = await getVoyageEmbedding(item.buyerQuestion)
      await db.$executeRaw`
        UPDATE "DeferToKetu"
        SET embedding = ${embedding}::vector, "updatedAt" = NOW()
        WHERE id = ${item.id}
      `
      updated++
    } catch (err) {
      console.error(`[Re-embed] Failed for "${item.buyerQuestion.substring(0, 50)}...":`, err.message)
      failed++
    }
  }

  console.log(`[Re-embed] Done: ${updated} updated, ${failed} failed out of ${items.length} total`)
  return { status: 'done', total: items.length, updated, failed }
}

/**
 * Re-embed all knowledge chunks with Voyage AI
 */
export async function reEmbedAllChunks(db, anthropic) {
  if (!VOYAGE_API_KEY) {
    return { status: 'skipped', reason: 'VOYAGE_API_KEY not configured' }
  }

  const chunks = await db.knowledgeChunk.findMany({
    select: { id: true, content: true, title: true },
  })

  let updated = 0
  let failed = 0

  for (const chunk of chunks) {
    try {
      const embedding = await getVoyageEmbedding(chunk.content)
      await db.$executeRaw`
        UPDATE "KnowledgeChunk"
        SET embedding = ${embedding}::vector, "updatedAt" = NOW()
        WHERE id = ${chunk.id}
      `
      updated++
    } catch (err) {
      console.error(`[Re-embed] Failed for chunk "${chunk.title?.substring(0, 50)}...":`, err.message)
      failed++
    }
  }

  console.log(`[Re-embed] Chunks: ${updated} updated, ${failed} failed out of ${chunks.length} total`)
  return { status: 'done', total: chunks.length, updated, failed }
}

/**
 * Check if Voyage AI is configured and working
 */
export function isVoyageConfigured() {
  return !!VOYAGE_API_KEY
}

/**
 * Get ALL knowledge chunks from the database (for small KB, send everything to Claude)
 */
export async function getAllChunks(db) {
  return db.knowledgeChunk.findMany({
    select: { id: true, source: true, title: true, content: true, metadata: true },
    orderBy: { source: 'asc' },
  })
}

/**
 * Store embedding for a knowledge chunk
 */
export async function storeChunkWithEmbedding(db, anthropic, { source, sourceId, title, content, metadata }) {
  const embedding = await getEmbedding(anthropic, content)

  const existing = await db.knowledgeChunk.findFirst({
    where: { source, sourceId },
  })

  if (existing) {
    await db.$executeRaw`
      UPDATE "KnowledgeChunk"
      SET content = ${content}, title = ${title}, metadata = ${JSON.stringify(metadata)}::jsonb,
          embedding = ${embedding}::vector, "updatedAt" = NOW()
      WHERE id = ${existing.id}
    `
    return { action: 'updated', id: existing.id }
  } else {
    const id = crypto.randomUUID()
    await db.$executeRaw`
      INSERT INTO "KnowledgeChunk" (id, source, "sourceId", title, content, metadata, embedding, "createdAt", "updatedAt")
      VALUES (${id}, ${source}::"ChunkSource", ${sourceId}, ${title}, ${content}, ${JSON.stringify(metadata)}::jsonb, ${embedding}::vector, NOW(), NOW())
    `
    return { action: 'created', id }
  }
}
