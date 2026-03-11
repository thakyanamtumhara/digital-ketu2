import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { PrismaClient } from '@prisma/client'
import Anthropic from '@anthropic-ai/sdk'
import { processIncomingMessage } from './process.js'
import { syncSavedReplies, syncCatalog, syncStylePairs } from './sync.js'
import { getEmbedding, reEmbedAllDeferItems, reEmbedAllChunks, isVoyageConfigured } from './embeddings.js'
import { runReviewJob, reviewBacklog, pullAndReviewHistory } from './reviewer.js'

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
  const { whatsappNumber, ketuReply, messageType, buyerMessage, aiReply, aiRepliedAt } = await c.req.json()
  if (!whatsappNumber) return c.json({ error: 'Missing whatsappNumber' }, 400)

  // Skip learning for non-text replies (audio, video, image, etc.) — only set cooldown
  const isTextReply = !messageType || messageType === 'TEXT'

  // 1. Set cooldown (existing behavior)
  const settings = await getSettings()
  const cooldownUntil = new Date(Date.now() + settings.cooldownMinutes * 60 * 1000)

  await db.buyerConversation.upsert({
    where: { whatsappNumber },
    update: { cooldownUntil, lastMessageAt: new Date() },
    create: { whatsappNumber, cooldownUntil, lastMessageAt: new Date() },
  })

  console.log(`[Cooldown] ${whatsappNumber} — paused until ${cooldownUntil.toISOString()}`)

  // 2. SELF-LEARNING: If AI was ON and replied recently (within 10 min), this is an intervention
  //    AI got it wrong → auto-add correction to DeferToKetu
  const isIntervention = aiReply && aiRepliedAt &&
    (Date.now() - new Date(aiRepliedAt).getTime()) < 10 * 60 * 1000

  let learned = null

  if (isTextReply && isIntervention && buyerMessage && ketuReply) {
    try {
      const embedding = await getEmbedding(anthropic, buyerMessage)
      await db.$executeRaw`
        INSERT INTO "DeferToKetu" (id, "buyerQuestion", "aiWrongReply", "correctReply", embedding, "triggerCount", "createdAt", "updatedAt")
        VALUES (${crypto.randomUUID()}, ${buyerMessage}, ${aiReply}, ${ketuReply}, ${embedding}::vector, 0, NOW(), NOW())
      `
      learned = 'intervention_correction'
      console.log(`[AutoLearn] Intervention — added correction: "${buyerMessage.substring(0, 50)}..."`)
    } catch (err) {
      console.error('[AutoLearn] Failed to add intervention correction:', err.message)
    }
  }

  // 3. SELF-LEARNING: If AI was OFF (no recent AI reply), store pair for batch review
  if (isTextReply && !isIntervention && buyerMessage && ketuReply) {
    try {
      await db.manualReplyPair.create({
        data: { whatsappNumber, buyerMessage, ketuReply },
      })
      learned = 'manual_pair_stored'
      console.log(`[AutoLearn] Manual pair stored: "${buyerMessage.substring(0, 50)}..."`)
    } catch (err) {
      console.error('[AutoLearn] Failed to store manual pair:', err.message)
    }
  }

  return c.json({ status: 'cooldown_set', cooldownUntil, learned })
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
// Self-Learning APIs
// ===========================================

// Manually trigger a review job
app.post('/api/learning/run', async (c) => {
  const settings = await getSettings()
  if (!settings.learningEnabled) {
    return c.json({ error: 'Learning is disabled. Enable it from Settings.' }, 400)
  }
  try {
    const result = await runReviewJob(db)
    // Track learning cost
    await db.settings.update({
      where: { id: 'default' },
      data: {
        lastReviewAt: new Date(),
        learningDailySpentUsd: { increment: result.totalCostUsd },
      },
    })
    return c.json(result)
  } catch (err) {
    console.error('[Learning] Manual run failed:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

// Reset manual pairs that were reviewed by wrong model (skipped/haiku) so they can be re-reviewed
app.post('/api/learning/reset-manual-pairs', async (c) => {
  const result = await db.manualReplyPair.updateMany({
    where: { reviewedAt: { not: null } },
    data: { reviewedAt: null, reviewResult: null, reviewNote: null, category: null },
  })
  return c.json({ reset: result.count, message: `Reset ${result.count} manual pairs for re-review` })
})

// One-time backlog review — review ALL past AI replies
let backlogRunning = false
let backlogProgress = null

app.post('/api/learning/backlog', async (c) => {
  if (backlogRunning) {
    return c.json({ error: 'Backlog review already running', progress: backlogProgress }, 409)
  }

  backlogRunning = true
  backlogProgress = { status: 'running', batchNumber: 0, totalReviewed: 0, totalCorrections: 0, totalCostUsd: 0 }

  // Run in background (don't block the request)
  reviewBacklog(db, (progress) => {
    backlogProgress = { status: 'running', ...progress }
  }).then(result => {
    backlogProgress = { status: 'complete', ...result }
    backlogRunning = false
    // Update learning cost
    db.settings.update({
      where: { id: 'default' },
      data: { learningDailySpentUsd: { increment: result.totalCostUsd } },
    }).catch(() => {})
    console.log(`[Backlog] Done: ${result.totalReviewed} reviewed, ${result.totalCorrections} corrections, $${result.totalCostUsd.toFixed(4)}`)
  }).catch(err => {
    backlogProgress = { status: 'failed', error: err.message }
    backlogRunning = false
    console.error('[Backlog] Failed:', err.message)
  })

  return c.json({ status: 'started', message: 'Backlog review started. Check /api/learning/backlog/progress for updates.' })
})

app.get('/api/learning/backlog/progress', async (c) => {
  if (!backlogProgress) return c.json({ status: 'not_started' })
  return c.json(backlogProgress)
})

// One-time history pull — fetch pairs from wwbun + review with Opus 4.6
// Default: 1000 pairs. Send { limit: 20 } for a quick test run.
let historyPullRunning = false
let historyPullProgress = null

app.post('/api/learning/history-pull', async (c) => {
  if (historyPullRunning) {
    return c.json({ error: 'History pull already running', progress: historyPullProgress }, 409)
  }

  const body = await c.req.json().catch(() => ({}))
  const limit = Math.min(Math.max(parseInt(body.limit) || 1000, 1), 2000) // 1-2000, default 1000

  historyPullRunning = true
  historyPullProgress = { status: 'running', phase: 'fetching', fetched: 0, stored: 0, reviewed: 0, corrections: 0, costUsd: 0 }

  // Run in background
  pullAndReviewHistory(db, (progress) => {
    historyPullProgress = { status: 'running', ...progress }
  }, { limit }).then(result => {
    historyPullProgress = { status: 'complete', ...result }
    historyPullRunning = false
    // Update learning cost
    db.settings.update({
      where: { id: 'default' },
      data: { learningDailySpentUsd: { increment: result.costUsd } },
    }).catch(() => {})
    console.log(`[HistoryPull] Done: ${result.fetched} fetched, ${result.stored} stored, ${result.reviewed} reviewed, ${result.corrections} corrections`)
  }).catch(err => {
    historyPullProgress = { status: 'failed', error: err.message }
    historyPullRunning = false
    console.error('[HistoryPull] Failed:', err.message)
  })

  return c.json({ status: 'started', message: 'History pull started. Check /api/learning/history-pull/progress for updates.' })
})

app.get('/api/learning/history-pull/progress', async (c) => {
  if (!historyPullProgress) return c.json({ status: 'not_started' })
  return c.json(historyPullProgress)
})

// Category breakdown for dashboard
app.get('/api/learning/categories', async (c) => {
  const categories = await db.manualReplyPair.groupBy({
    by: ['category'],
    where: { category: { not: null } },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  })

  const failsByCategory = await db.manualReplyPair.groupBy({
    by: ['category'],
    where: { category: { not: null }, reviewResult: 'correction_added' },
    _count: { id: true },
  })

  const failMap = {}
  for (const f of failsByCategory) {
    if (f.category) failMap[f.category] = f._count.id
  }

  return c.json(categories.map(c => ({
    category: c.category,
    total: c._count.id,
    aiWouldFail: failMap[c.category] || 0,
    failRate: c._count.id > 0 ? Math.round(((failMap[c.category] || 0) / c._count.id) * 100) : 0,
  })))
})

// Learning stats for dashboard
app.get('/api/learning/stats', async (c) => {
  const settings = await getSettings()

  const [
    totalCorrections,
    interventionCorrections,
    reviewerCorrections,
    manualPairCorrections,
    pendingManualPairs,
    totalAiReviewed,
    totalManualReviewed,
    avgRating,
    todayCorrections,
    recentLearnings,
  ] = await Promise.all([
    db.deferToKetu.count(),
    db.deferToKetu.count({ where: { aiWrongReply: { not: '[AI would not know]' } } }),
    db.messageLog.count({ where: { reviewedAt: { not: null }, reviewRating: { lte: 2 } } }),
    db.deferToKetu.count({ where: { aiWrongReply: '[AI would not know]' } }),
    db.manualReplyPair.count({ where: { reviewedAt: null } }),
    db.messageLog.count({ where: { reviewedAt: { not: null } } }),
    db.manualReplyPair.count({ where: { reviewedAt: { not: null } } }),
    db.messageLog.aggregate({ where: { reviewedAt: { not: null } }, _avg: { reviewRating: true } }),
    // Today's corrections (from all sources)
    db.deferToKetu.count({ where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
    // Recent learnings for "What I learned today" view
    db.deferToKetu.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, buyerQuestion: true, aiWrongReply: true, correctReply: true, createdAt: true },
    }),
  ])

  return c.json({
    enabled: settings.learningEnabled,
    intervalHours: settings.learningIntervalHours,
    lastReviewAt: settings.lastReviewAt,
    dailyCost: { spent: settings.learningDailySpentUsd, budget: settings.learningDailyBudgetUsd },
    stats: {
      totalCorrections,
      interventionCorrections,  // from Ketu intervening while AI ON
      reviewerCorrections,      // from Sonnet reviewing AI replies
      manualPairCorrections,    // from Sonnet reviewing manual pairs (AI OFF)
      pendingManualPairs,
      totalAiReviewed,
      totalManualReviewed,
      avgRating: avgRating._avg.reviewRating,
      todayCorrections,
    },
    recentLearnings,
  })
})

// Toggle learning on/off
app.put('/api/learning/toggle', async (c) => {
  const { enabled } = await c.req.json()
  await db.settings.update({
    where: { id: 'default' },
    data: { learningEnabled: !!enabled },
  })
  console.log(`[Learning] ${enabled ? 'Enabled' : 'Disabled'} by user`)
  return c.json({ learningEnabled: !!enabled })
})

// Recent AI reply reviews (for "What went wrong" view)
app.get('/api/learning/reviews', async (c) => {
  const limit = parseInt(c.req.query('limit') || '30')
  const reviews = await db.messageLog.findMany({
    where: { reviewedAt: { not: null } },
    orderBy: { reviewedAt: 'desc' },
    take: limit,
    select: {
      id: true, buyerMessage: true, aiReply: true,
      reviewedAt: true, reviewRating: true, reviewNote: true,
      createdAt: true,
    },
  })
  return c.json(reviews)
})

// Recent manual pair reviews (for "What I learned from your replies" view)
app.get('/api/learning/manual-pairs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '30')
  const pairs = await db.manualReplyPair.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return c.json(pairs)
})

// All pulled pairs (history pull) with summary
app.get('/api/learning/pulled-pairs', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const pageSize = parseInt(c.req.query('pageSize') || '50')
  const category = c.req.query('category') || null
  const result = c.req.query('result') || null // correction_added, ai_would_handle, skipped

  const where = { whatsappNumber: 'history_pull' }
  if (category) where.category = category
  if (result) where.reviewResult = result

  const [pairs, total, summary] = await Promise.all([
    db.manualReplyPair.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.manualReplyPair.count({ where }),
    // Summary stats
    (async () => {
      const baseWhere = { whatsappNumber: 'history_pull' }
      const [totalPulled, reviewed, corrections, aiHandled, skipped, categories] = await Promise.all([
        db.manualReplyPair.count({ where: baseWhere }),
        db.manualReplyPair.count({ where: { ...baseWhere, reviewedAt: { not: null } } }),
        db.manualReplyPair.count({ where: { ...baseWhere, reviewResult: 'correction_added' } }),
        db.manualReplyPair.count({ where: { ...baseWhere, reviewResult: 'ai_would_handle' } }),
        db.manualReplyPair.count({ where: { ...baseWhere, reviewResult: 'skipped' } }),
        db.manualReplyPair.groupBy({
          by: ['category'],
          where: { ...baseWhere, category: { not: null } },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
        }),
      ])
      // Also get corrections per category
      const correctionsByCategory = await db.manualReplyPair.groupBy({
        by: ['category'],
        where: { ...baseWhere, reviewResult: 'correction_added', category: { not: null } },
        _count: { id: true },
      })
      const corrMap = {}
      for (const c of correctionsByCategory) {
        if (c.category) corrMap[c.category] = c._count.id
      }
      return {
        totalPulled, reviewed, corrections, aiHandled, skipped,
        categories: categories.map(c => ({
          name: c.category,
          total: c._count.id,
          corrections: corrMap[c.category] || 0,
        })),
      }
    })(),
  ])

  return c.json({ pairs, total, page, pageSize, summary })
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

// ===========================================
// Embedding Management
// ===========================================

// Check embedding status
app.get('/api/embeddings/status', async (c) => {
  const voyageConfigured = isVoyageConfigured()
  const deferCount = await db.deferToKetu.count()
  const chunkCount = await db.knowledgeChunk.count()
  return c.json({
    voyageConfigured,
    embeddingModel: voyageConfigured ? 'voyage-3 (1024 dim)' : 'word-hash (basic)',
    deferItems: deferCount,
    knowledgeChunks: chunkCount,
  })
})

// Re-embed all defer items + knowledge chunks with Voyage AI
app.post('/api/embeddings/re-embed', async (c) => {
  if (!isVoyageConfigured()) {
    return c.json({ error: 'VOYAGE_API_KEY not configured. Add it to Railway env variables.' }, 400)
  }

  try {
    const [deferResult, chunkResult] = await Promise.all([
      reEmbedAllDeferItems(db, anthropic),
      reEmbedAllChunks(db, anthropic),
    ])
    return c.json({
      status: 'done',
      deferItems: deferResult,
      knowledgeChunks: chunkResult,
    })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

// ===========================================
// Pre-AI Filters Stats
// ===========================================

app.get('/api/filters/stats', async (c) => {
  const period = c.req.query('period') || 'today'
  const now = new Date()
  let since
  if (period === 'today') {
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  } else if (period === 'week') {
    since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  } else {
    since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  }

  const settings = await getSettings()

  // Count messages blocked by each filter (deferReason field)
  const [
    offHours,
    dailyLimit,
    emojiReaction,
    mediaOnly,
    billDocument,
    spam,
    cooldown,
    acknowledgment,
    welcomeBypass,
    deferToKetu,
    emptyKb,
    claudeDeferred,
    orderIdDetected,
    angryBuyer,
    informing,
    websiteIssue,
    repeatMessage,
    totalReplied,
    totalMessages,
  ] = await Promise.all([
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'off_hours' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'daily_limit' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'emoji_reaction' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'media_only' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'bill_document' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'spam' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, status: 'COOLDOWN' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'acknowledgment' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'welcome_bypass' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'defer_to_ketu' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'empty_knowledge_base' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'claude_deferred' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'order_id_detected' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'angry_buyer' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'informing' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'website_issue' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'repeat_message' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, status: 'REPLIED', totalTokens: { gt: 0 } } }),
    db.messageLog.count({ where: { createdAt: { gte: since } } }),
  ])

  const totalFiltered = offHours + dailyLimit + emojiReaction + mediaOnly + billDocument + spam + cooldown + acknowledgment + welcomeBypass + deferToKetu + emptyKb + orderIdDetected + angryBuyer + informing + websiteIssue + repeatMessage

  const honorificSuffixes = ['sir', 'ji', 'bhai', 'boss', 'bro', 'sahab', 'saheb', 'g']

  // Load dynamic keyword filters from DB (or use fallback display)
  let dynamicFilterCards = []
  try {
    const dbFilters = await db.preAIFilter.findMany({ orderBy: { priority: 'asc' } })
    if (dbFilters.length > 0) {
      // Count triggers for each dynamic filter by name
      const dynamicCounts = await Promise.all(
        dbFilters.map(f => db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: f.name } }))
      )
      dynamicFilterCards = dbFilters.map((f, i) => ({
        id: f.id,
        dbFilterId: f.id,
        name: f.displayName,
        description: f.description || '',
        type: 'keyword',
        matchType: f.matchType,
        currentState: f.enabled ? `${f.matchType === 'combo' ? 'combo logic' : f.keywords.split(',').filter(Boolean).length + ' keywords'} active` : 'Disabled',
        keywords: f.matchType === 'combo' ? [] : f.keywords.split(',').map(k => k.trim()).filter(Boolean),
        tokens: 0,
        triggered: dynamicCounts[i],
        action: f.action === 'skip' ? 'Skip silently' : f.action === 'defer' ? 'Defer message' : f.action === 'auto_reply' ? `Auto-reply: "${(f.autoReplyText || '').substring(0, 40)}"` : 'Welcome bypass',
        enabled: f.enabled,
        isSystem: f.isSystem,
        filterAction: f.action,
        autoReplyText: f.autoReplyText,
      }))
    }
  } catch {
    // DB not ready, dynamicFilterCards stays empty
  }

  // System filters (hardcoded, not editable)
  const systemFilters = [
    {
      id: 'system_active',
      name: 'System ON/OFF',
      description: 'AI is turned OFF — all messages skipped',
      type: 'system',
      currentState: settings.isActive ? 'Active (AI ON)' : 'Inactive (AI OFF)',
      tokens: 0,
      triggered: offHours,
      action: 'Skip silently',
    },
    {
      id: 'schedule',
      name: 'Working Hours',
      description: `Only process messages during ${settings.scheduleStart || 'N/A'} - ${settings.scheduleEnd || 'N/A'} IST`,
      type: 'system',
      currentState: settings.scheduleEnabled ? `${settings.scheduleStart} - ${settings.scheduleEnd}` : 'Disabled',
      tokens: 0,
      triggered: offHours,
      action: 'Skip silently',
    },
    {
      id: 'daily_budget',
      name: 'Daily Budget Limit',
      description: `Stop AI when daily spend reaches Rs ${settings.dailyBudgetInr}`,
      type: 'system',
      currentState: `Rs ${(settings.dailySpentUsd * 85).toFixed(0)} / Rs ${settings.dailyBudgetInr}`,
      tokens: 0,
      triggered: dailyLimit,
      action: 'Skip silently',
    },
    {
      id: 'emoji_reaction',
      name: 'Emoji Reactions',
      description: 'Skip reactions like thumbs up, heart, etc.',
      type: 'message',
      currentState: 'Always active',
      tokens: 0,
      triggered: emojiReaction,
      action: 'Skip silently',
    },
    {
      id: 'media_only',
      name: 'Media-Only Messages',
      description: 'Auto-reply to images, audio, video, documents',
      type: 'message',
      currentState: `Reply: "${settings.mediaMessage || 'N/A'}"`,
      tokens: 0,
      triggered: mediaOnly,
      action: 'Auto-reply (media message)',
    },
    {
      id: 'bill_document',
      name: 'BillNo PDF Detection',
      description: 'Detect invoice PDFs (BillNo*.pdf) and auto-acknowledge dispatch',
      type: 'keyword',
      currentState: 'Regex: [Document:.*BillNo.*\\.pdf]',
      tokens: 0,
      triggered: billDocument,
      action: 'Auto-reply: "Ok noted sir, dispatching ASAP"',
    },
    {
      id: 'empty_message',
      name: 'Empty / Spam Messages',
      description: 'Skip messages with no text content',
      type: 'message',
      currentState: 'Always active',
      tokens: 0,
      triggered: spam,
      action: 'Skip silently',
    },
    {
      id: 'cooldown',
      name: 'Manual Intervention Cooldown',
      description: `AI pauses for ${settings.cooldownMinutes} min after you reply manually`,
      type: 'user',
      currentState: `${settings.cooldownMinutes} min cooldown`,
      tokens: 0,
      triggered: cooldown,
      action: 'Skip silently',
    },
    {
      id: 'repeat_message',
      name: 'Repeat Message Detection',
      description: 'Skip if same buyer sent the exact same message within 5 minutes and AI already replied',
      type: 'message',
      currentState: '5 min window',
      tokens: 0,
      triggered: repeatMessage,
      action: 'Skip silently (already replied)',
    },
  ]

  // Post-filter items (not keyword-based)
  const postFilters = [
    {
      id: 'welcome_bypass',
      name: 'Welcome Message Bypass',
      description: 'First-time buyer or returning after 7+ days → send welcome directly',
      type: 'auto-reply',
      currentState: 'Active (7-day gap)',
      tokens: 0,
      triggered: welcomeBypass,
      action: 'Auto-reply with welcome message',
    },
    {
      id: 'order_id_detected',
      name: 'Order ID / Tracking Number',
      description: 'Detect long numeric strings (10+ digits) as order/tracking IDs and defer immediately',
      type: 'keyword',
      currentState: 'Regex: ^\\d{10,}$',
      tokens: 0,
      triggered: orderIdDetected,
      action: 'Defer message (0 tokens)',
    },
    {
      id: 'defer_to_ketu',
      name: 'Defer to Ketu (Vector Match)',
      description: 'Questions matching defer list → use correction or defer',
      type: 'ai-match',
      currentState: `Threshold: ${settings.deferThreshold}`,
      tokens: 0,
      triggered: deferToKetu,
      action: 'Auto-reply with correction OR defer message',
    },
    {
      id: 'empty_kb',
      name: 'Empty Knowledge Base',
      description: 'If no knowledge synced yet, defer all messages',
      type: 'system',
      currentState: 'Safety check',
      tokens: 0,
      triggered: emptyKb,
      action: 'Defer message',
    },
    {
      id: 'claude_deferred',
      name: 'Claude [DEFER] Marker',
      description: 'Claude itself says it cannot answer — defers to you',
      type: 'post-ai',
      currentState: 'Active',
      tokens: 'Yes (Claude called first)',
      triggered: claudeDeferred,
      action: 'Defer message (tokens consumed)',
    },
  ]

  return c.json({
    period,
    since,
    totalMessages,
    totalFiltered,
    totalReachedClaude: totalReplied + claudeDeferred,
    honorificSuffixes,
    filters: [
      ...systemFilters,
      ...dynamicFilterCards,
      ...postFilters,
    ],
  })
})

// ===========================================
// Pre-AI Filter Management (CRUD)
// ===========================================

import { clearFilterCache } from './process.js'

// Get all filters
app.get('/api/filters', async (c) => {
  try {
    const filters = await db.preAIFilter.findMany({ orderBy: { priority: 'asc' } })
    return c.json(filters)
  } catch {
    return c.json([])
  }
})

// Update filter (toggle enabled, change autoReplyText, etc.)
app.put('/api/filters/:id', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  // Only allow safe fields to be updated
  const allowed = ['enabled', 'displayName', 'description', 'autoReplyText', 'matchType', 'action', 'priority']
  const updates = {}
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key]
  }
  const filter = await db.preAIFilter.update({ where: { id }, data: updates })
  clearFilterCache()
  return c.json(filter)
})

// Add keyword to filter
app.post('/api/filters/:id/keywords', async (c) => {
  const { id } = c.req.param()
  const { keyword } = await c.req.json()
  if (!keyword || !keyword.trim()) return c.json({ error: 'Keyword required' }, 400)

  const filter = await db.preAIFilter.findUnique({ where: { id } })
  if (!filter) return c.json({ error: 'Filter not found' }, 404)

  const existing = filter.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
  if (existing.includes(keyword.trim().toLowerCase())) {
    return c.json({ error: 'Keyword already exists' }, 400)
  }

  const updatedKeywords = filter.keywords
    ? filter.keywords + ',' + keyword.trim().toLowerCase()
    : keyword.trim().toLowerCase()

  await db.preAIFilter.update({ where: { id }, data: { keywords: updatedKeywords } })
  clearFilterCache()
  return c.json({ ok: true })
})

// Remove keyword from filter
app.delete('/api/filters/:id/keywords/:keyword', async (c) => {
  const { id, keyword } = c.req.param()
  const filter = await db.preAIFilter.findUnique({ where: { id } })
  if (!filter) return c.json({ error: 'Filter not found' }, 404)

  const keywords = filter.keywords.split(',').map(k => k.trim()).filter(k => k.toLowerCase() !== decodeURIComponent(keyword).toLowerCase())
  await db.preAIFilter.update({ where: { id }, data: { keywords: keywords.join(',') } })
  clearFilterCache()
  return c.json({ ok: true })
})

// Create new filter (from discovered category)
app.post('/api/filters', async (c) => {
  const body = await c.req.json()
  if (!body.name || !body.displayName) return c.json({ error: 'name and displayName required' }, 400)

  // Sanitize name to snake_case
  const name = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

  const filter = await db.preAIFilter.create({
    data: {
      name,
      displayName: body.displayName,
      description: body.description || null,
      filterType: 'keyword',
      matchType: body.matchType || 'partial',
      action: body.action || 'skip',
      autoReplyText: body.autoReplyText || null,
      keywords: body.keywords || '',
      enabled: true,
      isSystem: false,
      priority: body.priority || 100,
    },
  })
  clearFilterCache()
  return c.json(filter)
})

// Delete a user-created filter (not system filters)
app.delete('/api/filters/:id', async (c) => {
  const { id } = c.req.param()
  const filter = await db.preAIFilter.findUnique({ where: { id } })
  if (!filter) return c.json({ error: 'Filter not found' }, 404)
  if (filter.isSystem) return c.json({ error: 'Cannot delete system filters' }, 400)

  await db.preAIFilter.delete({ where: { id } })
  clearFilterCache()
  return c.json({ ok: true })
})

// ===========================================
// Discovered Keywords (from AI learning)
// ===========================================

// Get pending + recently auto-added
app.get('/api/filters/discovered', async (c) => {
  try {
    const [pending, autoAdded] = await Promise.all([
      db.discoveredKeyword.findMany({
        where: { status: 'pending' },
        orderBy: { discoveredAt: 'desc' },
      }),
      db.discoveredKeyword.findMany({
        where: {
          status: 'auto_added',
          processedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { processedAt: 'desc' },
      }),
    ])
    return c.json({ pending, autoAdded })
  } catch {
    return c.json({ pending: [], autoAdded: [] })
  }
})

// Approve discovered keyword → add to filter
app.post('/api/filters/discovered/:id/approve', async (c) => {
  const { id } = c.req.param()
  const { filterId } = await c.req.json()

  const discovered = await db.discoveredKeyword.findUnique({ where: { id } })
  if (!discovered) return c.json({ error: 'Not found' }, 404)

  // Add keyword to the target filter
  const filter = await db.preAIFilter.findUnique({ where: { id: filterId } })
  if (!filter) return c.json({ error: 'Filter not found' }, 404)

  const existing = filter.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
  if (!existing.includes(discovered.keyword.toLowerCase())) {
    const updatedKeywords = filter.keywords
      ? filter.keywords + ',' + discovered.keyword.toLowerCase()
      : discovered.keyword.toLowerCase()
    await db.preAIFilter.update({ where: { id: filterId }, data: { keywords: updatedKeywords } })
  }

  await db.discoveredKeyword.update({
    where: { id },
    data: { status: 'approved', filterId, processedAt: new Date() },
  })

  clearFilterCache()
  return c.json({ ok: true })
})

// Dismiss discovered keyword
app.post('/api/filters/discovered/:id/dismiss', async (c) => {
  const { id } = c.req.param()
  await db.discoveredKeyword.update({
    where: { id },
    data: { status: 'dismissed', processedAt: new Date() },
  })
  return c.json({ ok: true })
})

// AI-discover keywords for a specific filter category
app.post('/api/filters/:id/ai-discover', async (c) => {
  const { id } = c.req.param()
  const filter = await db.preAIFilter.findUnique({ where: { id } })
  if (!filter) return c.json({ error: 'Filter not found' }, 404)

  // Get recent pairs of this category
  const pairs = await db.manualReplyPair.findMany({
    where: { category: filter.name },
    take: 100,
    orderBy: { createdAt: 'desc' },
  })

  if (pairs.length < 3) {
    return c.json({ error: 'Not enough data yet', count: pairs.length, needed: 3 })
  }

  const currentKeywords = filter.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)

  const prompt = `You analyze buyer messages from a wholesale blank t-shirt business (BulkPlainTshirt.com).

These messages belong to the "${filter.displayName}" category (action: ${filter.action}).

Current keywords already in this filter: ${currentKeywords.join(', ') || 'none'}

Buyer messages in this category:
${pairs.map(p => `- "${p.buyerMessage}"`).join('\n')}

Extract SHORT keywords/phrases (1-3 words, Hindi/English/Hinglish) that could detect similar messages.
- Only include keywords NOT already in the current list
- Must be specific enough to avoid false positives
- Assign confidence 0.0-1.0 (0.9+ = very sure, 0.7-0.89 = fairly sure, below 0.7 = uncertain)

Reply as JSON array only: [{ "keyword": "...", "confidence": 0.95 }]`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  })

  let newKeywords
  try {
    const text = response.content[0].text
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    newKeywords = JSON.parse(jsonMatch ? jsonMatch[0] : text)
  } catch {
    return c.json({ error: 'Failed to parse AI response' }, 500)
  }

  let autoAddedCount = 0
  let pendingCount = 0

  for (const kw of newKeywords) {
    if (!kw.keyword || currentKeywords.includes(kw.keyword.toLowerCase())) continue

    const isHighConfidence = kw.confidence >= 0.85

    await db.discoveredKeyword.create({
      data: {
        keyword: kw.keyword.toLowerCase(),
        category: filter.name,
        confidence: kw.confidence,
        source: 'manual_review',
        status: isHighConfidence ? 'auto_added' : 'pending',
        filterId: isHighConfidence ? filter.id : null,
        processedAt: isHighConfidence ? new Date() : null,
      },
    })

    if (isHighConfidence) {
      // Auto-add to filter
      const updatedKeywords = filter.keywords
        ? filter.keywords + ',' + kw.keyword.toLowerCase()
        : kw.keyword.toLowerCase()
      await db.preAIFilter.update({ where: { id: filter.id }, data: { keywords: updatedKeywords } })
      filter.keywords = updatedKeywords // Update local copy for next iteration
      currentKeywords.push(kw.keyword.toLowerCase())
      autoAddedCount++
    } else {
      pendingCount++
    }
  }

  clearFilterCache()
  return c.json({
    total: newKeywords.length,
    autoAdded: autoAddedCount,
    pending: pendingCount,
    message: `Found ${newKeywords.length} keywords: ${autoAddedCount} auto-added, ${pendingCount} need your review`,
  })
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

app.post('/api/sync/style-pairs', async (c) => {
  try {
    const result = await syncStylePairs(db, anthropic)
    return c.json(result)
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

app.post('/api/sync/all', async (c) => {
  try {
    const [replies, catalog, stylePairs] = await Promise.all([
      syncSavedReplies(db, anthropic),
      syncCatalog(db, anthropic),
      syncStylePairs(db, anthropic).catch(err => ({ status: 'failed', error: err.message })),
    ])
    // Update last sync time
    await db.settings.update({
      where: { id: 'default' },
      data: {
        lastSyncAt: new Date(),
        nextSyncAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days
      },
    })
    return c.json({ savedReplies: replies, catalog, stylePairs })
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
    // Style pairs: only sync on FIRST run (empty DB), not every 3 days
    // Om's communication style doesn't change — re-extract manually if needed
    if (chunkCount === 0) {
      await syncStylePairs(db, anthropic).catch(err => console.error('[Sync] Style pairs failed:', err.message))
    }
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
// Self-Learning Scheduler
// ===========================================

async function runScheduledReview() {
  try {
    const settings = await getSettings()
    if (!settings.learningEnabled) return

    // Check if enough time has passed since last review
    if (settings.lastReviewAt) {
      const hoursSince = (Date.now() - new Date(settings.lastReviewAt).getTime()) / (1000 * 60 * 60)
      if (hoursSince < settings.learningIntervalHours) return
    }

    // Reset daily spend counter at midnight
    const today = new Date(new Date().setHours(0, 0, 0, 0))
    if (!settings.learningSpentResetAt || new Date(settings.learningSpentResetAt) < today) {
      await db.settings.update({
        where: { id: 'default' },
        data: { learningDailySpentUsd: 0, learningSpentResetAt: today },
      })
    }

    // Check daily budget
    if (settings.learningDailySpentUsd >= settings.learningDailyBudgetUsd) {
      console.log('[Learning] Daily budget reached, skipping review')
      return
    }

    console.log('[Learning] Running scheduled review...')
    const result = await runReviewJob(db)

    await db.settings.update({
      where: { id: 'default' },
      data: {
        lastReviewAt: new Date(),
        learningDailySpentUsd: { increment: result.totalCostUsd },
      },
    })

    const totalCorrections = result.aiReplies.corrections + result.manualPairs.corrections
    const totalReviewed = result.aiReplies.reviewed + result.manualPairs.reviewed
    console.log(`[Learning] Review complete — ${totalReviewed} reviewed, ${totalCorrections} corrections, $${result.totalCostUsd.toFixed(4)} cost`)
  } catch (err) {
    console.error('[Learning] Scheduled review failed:', err.message)
  }
}

// Auto-review disabled — Ketu reviews manually via "Run Now" button
// setInterval(runScheduledReview, 60 * 60 * 1000)

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
