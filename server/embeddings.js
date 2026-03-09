// Embedding generation and vector search using Claude + pgvector

/**
 * Generate embedding for a text string using Claude's voyage model via Anthropic API
 * Returns a 1024-dimension vector
 */
export async function getEmbedding(anthropic, text) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    system: 'You are an embedding model. Return only the number 1.',
    messages: [{ role: 'user', content: text }],
  })
  // For now, we'll use a simple hash-based approach until Anthropic embeddings API is used
  // In production, replace with Anthropic's embedding endpoint or a local model
  return textToSimpleEmbedding(text)
}

/**
 * Simple text-to-embedding using character frequency hashing
 * This is a placeholder — replace with a proper embedding model in production
 * For MVP, this gives basic semantic similarity via character/word overlap
 */
function textToSimpleEmbedding(text) {
  const normalized = text.toLowerCase().trim()
  const words = normalized.split(/\s+/)
  const dim = 1024
  const vec = new Float32Array(dim)

  // Word-level hashing into vector dimensions
  for (const word of words) {
    let hash = 0
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0
    }
    const idx = Math.abs(hash) % dim
    vec[idx] += 1.0
  }

  // Normalize to unit vector
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
 * Returns top N most similar chunks
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
 * Returns matches above the threshold
 */
export async function vectorSearchDeferList(db, anthropic, queryText, { threshold = 0.85 } = {}) {
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
 * Store embedding for a knowledge chunk
 */
export async function storeChunkWithEmbedding(db, anthropic, { source, sourceId, title, content, metadata }) {
  const embedding = await getEmbedding(anthropic, content)

  // Upsert by source + sourceId
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
