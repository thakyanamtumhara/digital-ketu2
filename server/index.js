import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { PrismaClient } from '@prisma/client'
import Anthropic from '@anthropic-ai/sdk'
import { processIncomingMessage } from './process.js'
import { syncSavedReplies, syncCatalog } from './sync.js'
import { getEmbedding } from './embeddings.js'

const app = new Hono()
const db = new PrismaClient()
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// --- Middleware ---
app.use('*', cors({
  origin: '*',
  credentials: true,
}))

// --- Health Check ---
app.get('/api/health', (c) => c.json({ status: 'ok', service: 'digital-ketu2' }))

// --- Settings ---
async function getSettings() {
  let settings = await db.settings.findUnique({ where: { id: 'default' } })
  if (!settings) {
    settings = await db.settings.create({ data: { id: 'default' } })
  }
  // Reset daily spend if it's a new day
  const now = new Date()
  const resetAt = new Date(settings.dailySpentResetAt)
  if (now.toDateString() !== resetAt.toDateString()) {
    settings = await db.settings.update({
      where: { id: 'default' },
      data: { dailySpentUsd: 0, dailySpentResetAt: now }
    })
  }
  return settings
}

app.get('/api/settings', async (c) => {
  const settings = await getSettings()
  return c.json(settings)
})

app.put('/api/settings', async (c) => {
  const body = await c.req.json()
  const settings = await db.settings.update({
    where: { id: 'default' },
    data: body,
  })
  return c.json(settings)
})

// ===========================================
// CORE: Incoming message from wwbun
// ===========================================
// wwbun forwards incoming WhatsApp messages here

// Buffer for message merging (same sender within 3 sec = one thought)
const messageBuffer = new Map() // whatsappNumber -> { messages: [], timer: null }

app.post('/api/incoming', async (c) => {
  const body = await c.req.json()
  const {
    whatsappNumber,
    messageText,
    messageId,
    messageType,  // text, image, audio, video, document, etc.
    hasMedia,
    timestamp,
    senderName,
  } = body

  if (!whatsappNumber || !messageId) {
    return c.json({ error: 'Missing whatsappNumber or messageId' }, 400)
  }

  // Duplicate protection: check if we already processed this messageId
  const existing = await db.messageLog.findFirst({
    where: { messageIds: { has: messageId } }
  })
  if (existing) {
    return c.json({ status: 'duplicate', message: 'Already processed' })
  }

  // Add to merge buffer
  const bufferKey = whatsappNumber
  if (!messageBuffer.has(bufferKey)) {
    messageBuffer.set(bufferKey, { messages: [], timer: null })
  }
  const buffer = messageBuffer.get(bufferKey)
  buffer.messages.push({
    messageText: messageText || '',
    messageId,
    messageType: messageType || 'text',
    hasMedia: hasMedia || false,
    timestamp: timestamp || new Date().toISOString(),
    senderName,
  })

  // Clear existing timer and set new one (merge window)
  if (buffer.timer) clearTimeout(buffer.timer)

  const settings = await getSettings()
  buffer.timer = setTimeout(async () => {
    const merged = messageBuffer.get(bufferKey)
    messageBuffer.delete(bufferKey)
    if (!merged || merged.messages.length === 0) return

    try {
      await processIncomingMessage({
        whatsappNumber,
        messages: merged.messages,
        db,
        anthropic,
        settings,
      })
    } catch (err) {
      console.error(`[Process Error] ${whatsappNumber}:`, err.message)
    }
  }, settings.mergeWindowMs)

  return c.json({ status: 'buffered', bufferSize: buffer.messages.length })
})

// ===========================================
// Manual Intervention Detection
// ===========================================
// wwbun calls this when Om sends a manual message in a conversation

app.post('/api/intervention', async (c) => {
  const { whatsappNumber } = await c.req.json()
  if (!whatsappNumber) return c.json({ error: 'Missing whatsappNumber' }, 400)

  const settings = await getSettings()
  const cooldownUntil = new Date(Date.now() + settings.cooldownMinutes * 60 * 1000)

  await db.buyerConversation.upsert({
    where: { whatsappNumber },
    update: { cooldownUntil },
    create: { whatsappNumber, cooldownUntil },
  })

  console.log(`[Cooldown] ${whatsappNumber} — paused until ${cooldownUntil.toISOString()}`)
  return c.json({ status: 'cooldown_set', cooldownUntil })
})

// ===========================================
// Edit Button Callback (Defer to Ketu)
// ===========================================
// wwbun calls this when Om edits an AI reply via the Edit button

app.post('/api/correction', async (c) => {
  const { buyerQuestion, aiWrongReply, correctReply } = await c.req.json()
  if (!buyerQuestion || !correctReply) {
    return c.json({ error: 'Missing buyerQuestion or correctReply' }, 400)
  }

  // Generate embedding for the buyer question
  const embedding = await getEmbedding(anthropic, buyerQuestion)

  await db.$executeRaw`
    INSERT INTO "DeferToKetu" (id, "buyerQuestion", "aiWrongReply", "correctReply", embedding, "triggerCount", "createdAt", "updatedAt")
    VALUES (${crypto.randomUUID()}, ${buyerQuestion}, ${aiWrongReply || ''}, ${correctReply}, ${embedding}::vector, 0, NOW(), NOW())
  `

  console.log(`[Defer to Ketu] Added: "${buyerQuestion.substring(0, 50)}..."`)
  return c.json({ status: 'saved' })
})

// ===========================================
// Dashboard APIs
// ===========================================

// Recent message logs
app.get('/api/logs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')
  const logs = await db.messageLog.findMany({
    include: { conversation: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  })
  return c.json(logs)
})

// Analytics / aggregate stats
app.get('/api/analytics', async (c) => {
  const period = c.req.query('period') || 'today' // today, week, month
  const now = new Date()
  let since
  if (period === 'today') {
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  } else if (period === 'week') {
    since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  } else {
    since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  }

  const [totalMessages, totalReplied, totalDeferred, totalSkipped, tokenStats] = await Promise.all([
    db.messageLog.count({ where: { createdAt: { gte: since } } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, status: 'REPLIED' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, status: 'DEFERRED' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, status: 'SKIPPED' } }),
    db.messageLog.aggregate({
      where: { createdAt: { gte: since }, status: 'REPLIED' },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true, costUsd: true },
      _avg: { totalTokens: true, costUsd: true, processingMs: true },
    }),
  ])

  const settings = await getSettings()

  return c.json({
    period,
    since,
    totalMessages,
    totalReplied,
    totalDeferred,
    totalSkipped,
    interventionRate: totalMessages > 0
      ? ((totalDeferred / totalMessages) * 100).toFixed(1) + '%'
      : '0%',
    tokens: {
      totalInput: tokenStats._sum.promptTokens || 0,
      totalOutput: tokenStats._sum.completionTokens || 0,
      total: tokenStats._sum.totalTokens || 0,
      totalCostUsd: tokenStats._sum.costUsd || 0,
      avgTokensPerReply: Math.round(tokenStats._avg.totalTokens || 0),
      avgCostPerReply: tokenStats._avg.costUsd || 0,
      avgProcessingMs: Math.round(tokenStats._avg.processingMs || 0),
    },
    dailyBudget: {
      limitInr: settings.dailyBudgetInr,
      spentUsd: settings.dailySpentUsd,
      spentInr: settings.dailySpentUsd * 85, // approximate USD to INR
      percentUsed: settings.dailyBudgetInr > 0
        ? (((settings.dailySpentUsd * 85) / settings.dailyBudgetInr) * 100).toFixed(1) + '%'
        : '0%',
    },
  })
})

// Defer to Ketu list management
app.get('/api/defer-list', async (c) => {
  const items = await db.deferToKetu.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      buyerQuestion: true,
      aiWrongReply: true,
      correctReply: true,
      triggerCount: true,
      createdAt: true,
    }
  })
  return c.json(items)
})

app.delete('/api/defer-list/:id', async (c) => {
  const { id } = c.req.param()
  await db.deferToKetu.delete({ where: { id } })
  return c.json({ status: 'deleted' })
})

// Knowledge base download
app.get('/api/knowledge/download', async (c) => {
  const [chunks, deferList, settings] = await Promise.all([
    db.knowledgeChunk.findMany({
      select: { id: true, source: true, sourceId: true, title: true, content: true, metadata: true, updatedAt: true },
      orderBy: { source: 'asc' },
    }),
    db.deferToKetu.findMany({
      select: { buyerQuestion: true, correctReply: true, createdAt: true },
    }),
    getSettings(),
  ])

  const knowledgeBase = {
    exportedAt: new Date().toISOString(),
    totalChunks: chunks.length,
    chunks: chunks.reduce((acc, chunk) => {
      const key = chunk.source
      if (!acc[key]) acc[key] = []
      acc[key].push({
        title: chunk.title,
        content: chunk.content,
        metadata: chunk.metadata,
        updatedAt: chunk.updatedAt,
      })
      return acc
    }, {}),
    deferToKetuList: deferList,
    settings: {
      confidenceThreshold: settings.confidenceThreshold,
      deferThreshold: settings.deferThreshold,
      deferMessage: settings.deferMessage,
      mediaMessage: settings.mediaMessage,
    },
  }

  c.header('Content-Disposition', 'attachment; filename="knowledge-base.json"')
  return c.json(knowledgeBase)
})

// ===========================================
// Sync Endpoints
// ===========================================

app.post('/api/sync/saved-replies', async (c) => {
  try {
    const result = await syncSavedReplies(db, anthropic)
    return c.json(result)
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

app.post('/api/sync/catalog', async (c) => {
  try {
    const result = await syncCatalog(db, anthropic)
    return c.json(result)
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

app.post('/api/sync/all', async (c) => {
  try {
    const [replies, catalog] = await Promise.all([
      syncSavedReplies(db, anthropic),
      syncCatalog(db, anthropic),
    ])
    // Update last sync time
    await db.settings.update({
      where: { id: 'default' },
      data: {
        lastSyncAt: new Date(),
        nextSyncAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days
      },
    })
    return c.json({ savedReplies: replies, catalog })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

// Sync log history
app.get('/api/sync/logs', async (c) => {
  const logs = await db.syncLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  return c.json(logs)
})

// ===========================================
// Scheduled Sync (every 3 days)
// ===========================================

async function runScheduledSync() {
  // Force sync if knowledge base is empty (first deploy or after DB reset)
  const chunkCount = await db.knowledgeChunk.count()
  if (chunkCount === 0) {
    console.log('[Sync] Knowledge base is EMPTY — forcing initial sync...')
  } else {
    const settings = await getSettings()
    if (settings.nextSyncAt && new Date() < new Date(settings.nextSyncAt)) return
  }

  console.log('[Sync] Running scheduled sync...')
  try {
    await syncSavedReplies(db, anthropic)
    await syncCatalog(db, anthropic)
    await db.settings.update({
      where: { id: 'default' },
      data: {
        lastSyncAt: new Date(),
        nextSyncAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    })
    const newCount = await db.knowledgeChunk.count()
    console.log(`[Sync] Scheduled sync complete — ${newCount} knowledge chunks now in DB`)
  } catch (err) {
    console.error('[Sync] Scheduled sync failed:', err.message)
  }
}

// Check every hour if sync is due
setInterval(runScheduledSync, 60 * 60 * 1000)

// ===========================================
// Serve Dashboard (Static Frontend)
// ===========================================

app.use('/*', serveStatic({ root: './dist' }))
app.get('/*', serveStatic({ path: './dist/index.html' }))

// ===========================================
// Start Server
// ===========================================

const port = parseInt(process.env.PORT || '3000')

export default {
  port,
  fetch: app.fetch,
}

console.log(`[digital-ketu2] Server running on port ${port}`)

// Run initial sync check on startup
runScheduledSync().catch(err => console.error('[Sync] Startup sync check failed:', err.message))

export { db, anthropic, getSettings }
