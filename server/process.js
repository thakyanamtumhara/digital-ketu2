// Core message processing pipeline
// Handles: merge → dedup → media check → cooldown → defer check → RAG → Claude → reply

import { vectorSearch, vectorSearchDeferList } from './embeddings.js'

const WWBUN_API_URL = process.env.WWBUN_API_URL
const DIGITAL_KETU_SECRET = process.env.DIGITAL_KETU_SECRET

// Claude pricing (Haiku 4.5 — cheapest for high volume)
const PRICE_PER_INPUT_TOKEN = 0.000001   // $1 per 1M input tokens
const PRICE_PER_OUTPUT_TOKEN = 0.000005  // $5 per 1M output tokens
const USD_TO_INR = 85

/**
 * Main processing function — called after message merge window closes
 */
export async function processIncomingMessage({ whatsappNumber, messages, db, anthropic, settings }) {
  const startTime = Date.now()

  // Get or create buyer conversation
  const conversation = await db.buyerConversation.upsert({
    where: { whatsappNumber },
    update: {
      lastMessageAt: new Date(),
      messageCount: { increment: messages.length },
    },
    create: {
      whatsappNumber,
      lastMessageAt: new Date(),
      messageCount: messages.length,
    },
  })

  const messageIds = messages.map(m => m.messageId)
  const hasTextMessages = messages.some(m => m.messageType === 'text' && m.messageText?.trim())
  const hasMediaOnly = !hasTextMessages && messages.some(m => m.hasMedia || m.messageType !== 'text')
  const mergedText = messages
    .filter(m => m.messageText?.trim())
    .map(m => m.messageText.trim())
    .join(' ')

  // --- Check: Is system active? ---
  if (!settings.isActive) {
    await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
      status: 'SKIPPED',
      deferReason: 'off_hours',
      processingMs: Date.now() - startTime,
      isMedia: hasMediaOnly,
    })
    return
  }

  // --- Check: Working hours schedule ---
  if (settings.scheduleEnabled && settings.scheduleStart && settings.scheduleEnd) {
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
    const hours = nowIST.getHours()
    const minutes = nowIST.getMinutes()
    const currentTime = hours * 60 + minutes
    const [startH, startM] = settings.scheduleStart.split(':').map(Number)
    const [endH, endM] = settings.scheduleEnd.split(':').map(Number)
    const startTime_ = startH * 60 + startM
    const endTime_ = endH * 60 + endM

    if (currentTime < startTime_ || currentTime > endTime_) {
      await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
        status: 'SKIPPED',
        deferReason: 'off_hours',
        processingMs: Date.now() - startTime,
        isMedia: hasMediaOnly,
      })
      return
    }
  }

  // --- Check: Daily budget ---
  const dailySpentInr = settings.dailySpentUsd * USD_TO_INR
  if (dailySpentInr >= settings.dailyBudgetInr) {
    await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
      status: 'SKIPPED',
      deferReason: 'daily_limit',
      processingMs: Date.now() - startTime,
      isMedia: hasMediaOnly,
    })
    return
  }

  // --- Check: Media-only message ---
  if (hasMediaOnly) {
    await sendReplyViaWwbun(whatsappNumber, settings.mediaMessage)
    await createLog(db, conversation.id, '[media]', messageIds, {
      status: 'REPLIED',
      aiReply: settings.mediaMessage,
      deferReason: 'media_only',
      processingMs: Date.now() - startTime,
      isMedia: true,
      sentViaWwbun: true,
    })
    return
  }

  // --- Check: No text content (spam/empty) ---
  if (!mergedText.trim()) {
    await createLog(db, conversation.id, '[empty]', messageIds, {
      status: 'SKIPPED',
      deferReason: 'spam',
      processingMs: Date.now() - startTime,
    })
    return
  }

  // --- Check: Cooldown (Om intervened) ---
  if (conversation.cooldownUntil && new Date() < new Date(conversation.cooldownUntil)) {
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'COOLDOWN',
      deferReason: 'cooldown',
      processingMs: Date.now() - startTime,
    })
    return
  }

  // --- Check: Post-defer acknowledgment ---
  // If last message was deferred and buyer just acknowledged (ok, thanks, etc.), stay silent
  const lastLog = await db.messageLog.findFirst({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
    select: { status: true },
  })

  if (lastLog && lastLog.status === 'DEFERRED') {
    const normalizedText = mergedText.trim().toLowerCase()
      .replace(/[.!?,।]+$/g, '')
      .trim()

    const ackPatterns = [
      'ok', 'okay', 'fine', 'sure', 'thanks', 'thank you', 'alright',
      'got it', 'noted', 'understood', 'no problem', 'np', 'cool',
      'great', 'good', 'right', 'yes', 'yep', 'ya', 'yaa',
      'theek hai', 'thik hai', 'accha', 'acha', 'sahi hai',
      'ji', 'haan', 'ha', 'dhanyavaad', 'shukriya', 'bas',
      'theek', 'thik', 'achchha', 'hmm', 'hm', 'k', 'kk',
    ]

    if (ackPatterns.includes(normalizedText)) {
      await createLog(db, conversation.id, mergedText, messageIds, {
        status: 'SKIPPED',
        deferReason: 'post_defer_ack',
        processingMs: Date.now() - startTime,
      })
      return
    }
  }

  // --- Check: Defer to Ketu list ---
  const deferMatch = await vectorSearchDeferList(db, anthropic, mergedText, {
    threshold: settings.deferThreshold,
  })
  if (deferMatch) {
    // Increment trigger count
    await db.deferToKetu.update({
      where: { id: deferMatch.id },
      data: { triggerCount: { increment: 1 } },
    })
    await sendReplyViaWwbun(whatsappNumber, settings.deferMessage)
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'DEFERRED',
      deferReason: 'defer_to_ketu',
      similarityScore: deferMatch.similarity,
      aiReply: settings.deferMessage,
      processingMs: Date.now() - startTime,
      sentViaWwbun: true,
    })
    return
  }

  // --- RAG: Search knowledge base ---
  const chunks = await vectorSearch(db, anthropic, mergedText, { limit: 7, minSimilarity: 0.0 })
  const bestSimilarity = chunks.length > 0 ? chunks[0].similarity : 0

  // --- Check: Low confidence ---
  if (bestSimilarity < settings.confidenceThreshold) {
    await sendReplyViaWwbun(whatsappNumber, settings.deferMessage)
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'DEFERRED',
      deferReason: 'low_confidence',
      similarityScore: bestSimilarity,
      knowledgeChunks: chunks.map(c => ({ title: c.title, source: c.source, similarity: c.similarity })),
      aiReply: settings.deferMessage,
      processingMs: Date.now() - startTime,
      sentViaWwbun: true,
    })
    return
  }

  // --- Build prompt for Claude ---
  const isFirstTime = conversation.isFirstTime

  // Get recent conversation history (last 5 messages)
  const recentLogs = await db.messageLog.findMany({
    where: { conversationId: conversation.id, status: 'REPLIED' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { buyerMessage: true, aiReply: true },
  })
  const conversationHistory = recentLogs.reverse()

  // Separate catalog chunks for display
  const catalogChunks = chunks.filter(c => c.source === 'CATALOG')
  const otherChunks = chunks.filter(c => c.source !== 'CATALOG')

  const systemPrompt = buildSystemPrompt({ isFirstTime, settings })
  const userPrompt = buildUserPrompt({
    mergedText,
    chunks: otherChunks,
    catalogChunks,
    conversationHistory,
  })

  // --- Call Claude API ---
  let aiReply
  let promptTokens, completionTokens, totalTokens, costUsd

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })

    aiReply = response.content[0].text
    promptTokens = response.usage.input_tokens
    completionTokens = response.usage.output_tokens
    totalTokens = promptTokens + completionTokens
    costUsd = (promptTokens * PRICE_PER_INPUT_TOKEN) + (completionTokens * PRICE_PER_OUTPUT_TOKEN)
  } catch (err) {
    console.error(`[Claude Error] ${whatsappNumber}:`, err.message)
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'FAILED',
      deferReason: err.message,
      knowledgeChunks: chunks.map(c => ({ title: c.title, source: c.source, similarity: c.similarity })),
      processingMs: Date.now() - startTime,
    })
    return
  }

  // --- Send reply via wwbun ---
  const sendResult = await sendReplyViaWwbun(whatsappNumber, aiReply)

  // --- Update daily spend ---
  await db.settings.update({
    where: { id: 'default' },
    data: { dailySpentUsd: { increment: costUsd } },
  })

  // --- Mark first-time buyer as returning ---
  if (isFirstTime) {
    await db.buyerConversation.update({
      where: { id: conversation.id },
      data: { isFirstTime: false },
    })
  }

  // --- Log ---
  await createLog(db, conversation.id, mergedText, messageIds, {
    status: 'REPLIED',
    aiReply,
    knowledgeChunks: chunks.map(c => ({ title: c.title, source: c.source, similarity: c.similarity })),
    similarityScore: bestSimilarity,
    catalogMatch: catalogChunks.length > 0 ? catalogChunks[0].metadata : null,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd,
    promptSent: { system: systemPrompt, user: userPrompt },
    sentViaWwbun: !!sendResult,
    wwbunMessageId: sendResult?.messageId || null,
    processingMs: Date.now() - startTime,
  })

  console.log(`[Reply] ${whatsappNumber} — ${totalTokens} tokens, $${costUsd.toFixed(6)}, ${Date.now() - startTime}ms`)
}

// ===========================================
// Prompt Building
// ===========================================

function buildSystemPrompt({ isFirstTime, settings }) {
  let prompt = `You are Ketu's assistant — an AI that replies to WhatsApp buyers for a wholesale blank t-shirt business (BulkPlainTshirt.com / sale91.com).

RULES:
- Reply in the buyer's language. If they write Hindi, reply in Hindi. If English, reply in English. If Hinglish, reply in Hinglish.
- Be friendly, professional, and helpful. Sound like a real person, not a robot.
- Keep replies concise — WhatsApp messages should be short and readable.
- Never make up information. Only use the knowledge provided below.
- If you don't have enough info to answer, say Ketu will get back to them shortly.
- When buyer shows buying intent (asking about pricing, MOQ, how to order), guide them to buy from sale91.com and suggest ordering samples from the website.
- Always share sale91.com when purchase intent is detected.
- Never reveal you are an AI. You are Ketu's assistant.
- Use natural greetings appropriate to the language (Namaste, Hello, Hi, etc.).`

  if (isFirstTime) {
    prompt += `\n\nIMPORTANT: This is the buyer's FIRST message ever. You MUST include the catalog link sale91.com/catalog in your reply, regardless of what they ask.`
  }

  return prompt
}

function buildUserPrompt({ mergedText, chunks, catalogChunks, conversationHistory }) {
  let prompt = ''

  // Knowledge chunks
  if (chunks.length > 0) {
    prompt += `KNOWLEDGE BASE (use this info to answer):\n`
    for (const chunk of chunks) {
      prompt += `---\n[${chunk.source}] ${chunk.title || ''}\n${chunk.content}\n`
    }
    prompt += '\n'
  }

  // Catalog info
  if (catalogChunks.length > 0) {
    prompt += `PRODUCT CATALOG INFO:\n`
    for (const chunk of catalogChunks) {
      prompt += `---\n${chunk.title || ''}\n${chunk.content}\n`
      if (chunk.metadata) {
        const meta = typeof chunk.metadata === 'string' ? JSON.parse(chunk.metadata) : chunk.metadata
        if (meta.bulkPrice) prompt += `Bulk price: ₹${meta.bulkPrice}/pc\n`
        if (meta.samplePrice) prompt += `Sample price: ₹${meta.samplePrice}/pc\n`
        if (meta.colors) prompt += `Colors: ${meta.colors.join(', ')}\n`
        if (meta.sizes) prompt += `Sizes: ${meta.sizes.join(', ')}\n`
      }
    }
    prompt += '\n'
  }

  // Conversation history
  if (conversationHistory.length > 0) {
    prompt += `RECENT CONVERSATION:\n`
    for (const msg of conversationHistory) {
      prompt += `Buyer: ${msg.buyerMessage}\nAssistant: ${msg.aiReply}\n\n`
    }
  }

  // Current message
  prompt += `BUYER'S NEW MESSAGE:\n${mergedText}\n\nReply as Ketu's assistant:`

  return prompt
}

// ===========================================
// Send reply via wwbun API
// ===========================================

async function sendReplyViaWwbun(whatsappNumber, message) {
  if (!WWBUN_API_URL || !DIGITAL_KETU_SECRET) {
    console.warn('[Send] WWBUN_API_URL or DIGITAL_KETU_SECRET not configured, skipping send')
    return null
  }

  try {
    const response = await fetch(`${WWBUN_API_URL}/api/messages/send-ai-reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Digital-Ketu-Secret': DIGITAL_KETU_SECRET,
      },
      body: JSON.stringify({
        whatsappNumber,
        message,
        isAiGenerated: true,
      }),
    })

    if (!response.ok) {
      console.error(`[Send] wwbun API error: ${response.status} ${response.statusText}`)
      return null
    }

    const result = await response.json()
    return result
  } catch (err) {
    console.error(`[Send] Failed to send via wwbun:`, err.message)
    return null
  }
}

// ===========================================
// Helper: Create message log
// ===========================================

async function createLog(db, conversationId, buyerMessage, messageIds, data) {
  return db.messageLog.create({
    data: {
      conversationId,
      buyerMessage,
      messageIds,
      ...data,
    },
  })
}
