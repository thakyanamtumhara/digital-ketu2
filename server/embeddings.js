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
  const results = await getVoyageEmbeddingsBatch([text])
  return results[0]
}

/**
 * Batch embedding: send multiple texts in one API call (max 128 per call)
 * Returns array of pgvector-compatible embedding strings
 */
export async function getVoyageBatch(texts) {
  return getVoyageEmbeddingsBatch(texts)
}

async function getVoyageEmbeddingsBatch(texts) {
  const BATCH_SIZE = 128
  const allResults = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const response = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: batch,
        input_type: 'query',
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      console.error(`[Voyage AI] API error: ${response.status} — ${err}`)
      // Fall back to hash-based for this batch
      for (const text of batch) {
        allResults.push(textToSimpleEmbedding(text))
      }
      continue
    }

    const data = await response.json()
    if (data.usage) {
      console.log(`[Voyage AI] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${data.usage.total_tokens} tokens used`)
    }

    for (const item of data.data) {
      allResults.push(`[${item.embedding.join(',')}]`)
    }
  }

  return allResults
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
 * @param {Object} options
 * @param {number} options.limit - Max results to return
 * @param {number} options.minSimilarity - Min cosine similarity (0-1)
 * @param {string[]} options.sources - Only search these ChunkSource types (e.g., ['CATALOG', 'SAVED_REPLY'])
 * @param {string[]} options.excludeSources - Exclude these ChunkSource types
 */
export async function vectorSearch(db, anthropic, queryText, { limit = 5, minSimilarity = 0.0, sources = null, excludeSources = null } = {}) {
  const embedding = await getEmbedding(anthropic, queryText)

  let results
  if (sources && sources.length > 0) {
    // Filter to specific sources
    results = await db.$queryRaw`
      SELECT
        id, source, "sourceId", title, content, metadata,
        1 - (embedding <=> ${embedding}::vector) as similarity
      FROM "KnowledgeChunk"
      WHERE embedding IS NOT NULL
        AND source::text = ANY(${sources})
      ORDER BY embedding <=> ${embedding}::vector
      LIMIT ${limit}
    `
  } else if (excludeSources && excludeSources.length > 0) {
    // Exclude specific sources
    results = await db.$queryRaw`
      SELECT
        id, source, "sourceId", title, content, metadata,
        1 - (embedding <=> ${embedding}::vector) as similarity
      FROM "KnowledgeChunk"
      WHERE embedding IS NOT NULL
        AND source::text != ALL(${excludeSources})
      ORDER BY embedding <=> ${embedding}::vector
      LIMIT ${limit}
    `
  } else {
    // Search all sources
    results = await db.$queryRaw`
      SELECT
        id, source, "sourceId", title, content, metadata,
        1 - (embedding <=> ${embedding}::vector) as similarity
      FROM "KnowledgeChunk"
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${embedding}::vector
      LIMIT ${limit}
    `
  }

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

  if (items.length === 0) {
    return { status: 'done', total: 0, updated: 0, failed: 0 }
  }

  // Batch embed all questions in one API call
  const texts = items.map(item => item.buyerQuestion)
  const embeddings = await getVoyageEmbeddingsBatch(texts)

  let updated = 0
  let failed = 0

  for (let i = 0; i < items.length; i++) {
    try {
      await db.$executeRaw`
        UPDATE "DeferToKetu"
        SET embedding = ${embeddings[i]}::vector, "updatedAt" = NOW()
        WHERE id = ${items[i].id}
      `
      updated++
    } catch (err) {
      console.error(`[Re-embed] Failed for "${items[i].buyerQuestion.substring(0, 50)}...":`, err.message)
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

  if (chunks.length === 0) {
    return { status: 'done', total: 0, updated: 0, failed: 0 }
  }

  // Batch embed all chunks in one API call
  const texts = chunks.map(chunk => chunk.content)
  const embeddings = await getVoyageEmbeddingsBatch(texts)

  let updated = 0
  let failed = 0

  for (let i = 0; i < chunks.length; i++) {
    try {
      await db.$executeRaw`
        UPDATE "KnowledgeChunk"
        SET embedding = ${embeddings[i]}::vector, "updatedAt" = NOW()
        WHERE id = ${chunks[i].id}
      `
      updated++
    } catch (err) {
      console.error(`[Re-embed] Failed for chunk "${chunks[i].title?.substring(0, 50)}...":`, err.message)
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
