// Core message processing pipeline
// Handles: merge → dedup → media check → cooldown → vector search → Claude → reply
//
// Vector-based system (v2):
// 1. Buyer message → Voyage AI embedding
// 2. Single vector search across ALL 4 sources (catalog, reply templates, 337 style pairs, corrections) → top 5
// 3. Best match ≥ 80% (confidenceThreshold) → send top 5 to Claude → reply
// 4. Best match < 80% → defer to Ketu (not enough knowledge)

import { vectorSearch } from './embeddings.js'

// ===========================================
// Dynamic Pre-AI Filter Cache
// ===========================================
let filterCache = { filters: null, loadedAt: 0 }
const FILTER_CACHE_TTL = 5 * 60 * 1000 // 5 min

async function loadKeywordFilters(db) {
  if (filterCache.filters && Date.now() - filterCache.loadedAt < FILTER_CACHE_TTL) {
    return filterCache.filters
  }
  try {
    const filters = await db.preAIFilter.findMany({
      where: { enabled: true, filterType: 'keyword' },
      orderBy: { priority: 'asc' },
    })
    if (filters.length > 0) {
      filterCache = { filters, loadedAt: Date.now() }
      return filters
    }
  } catch {
    // Table might not exist yet (migration not run) — fall back to null
  }
  return null // null = use hardcoded fallback
}

export function clearFilterCache() {
  filterCache = { filters: null, loadedAt: 0 }
}

function checkKeywordMatch(text, lowerMsg, filter) {
  if (filter.matchType === 'exact') {
    const keywords = filter.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    return keywords.includes(text)
  }
  if (filter.matchType === 'partial') {
    const keywords = filter.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    return keywords.some(kw => lowerMsg.includes(kw))
  }
  if (filter.matchType === 'combo') {
    try {
      const config = JSON.parse(filter.keywords)
      const hasSiteWord = config.siteWords.some(w => lowerMsg.includes(w))
      const hasIssueWord = config.issueWords.some(w => lowerMsg.includes(w))
      const hasDirectKw = config.directKws.some(kw => lowerMsg.includes(kw))
      const hasExclude = config.excludeWords && config.excludeWords.some(w => lowerMsg.includes(w))
      return ((hasSiteWord && hasIssueWord) || hasDirectKw) && !hasExclude
    } catch {
      return false
    }
  }
  return false
}

async function autoLearnAcknowledgment(db, phrase) {
  if (!phrase) return
  try {
    const ackFilter = await db.preAIFilter.findUnique({ where: { name: 'acknowledgment' } })
    if (!ackFilter) return
    const existing = ackFilter.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    if (existing.includes(phrase)) return
    await db.preAIFilter.update({
      where: { id: ackFilter.id },
      data: { keywords: ackFilter.keywords + ',' + phrase },
    })
    await db.discoveredKeyword.create({
      data: {
        keyword: phrase,
        category: 'acknowledgment',
        confidence: 1.0,
        source: 'auto_skip',
        status: 'auto_added',
        filterId: ackFilter.id,
      },
    })
    clearFilterCache()
    console.log(`[Auto-Learn] Added "${phrase}" to acknowledgment filter`)
  } catch (err) {
    console.error('[Auto-Learn] Error:', err.message)
  }
}

const WWBUN_API_URL = process.env.WWBUN_API_URL
const DIGITAL_KETU_SECRET = process.env.DIGITAL_KETU_SECRET

// Default system prompt (used when dashboard systemPrompt field is empty)
const DEFAULT_SYSTEM_PROMPT = `You are Ketu's assistant — an AI that replies to WhatsApp buyers for a wholesale blank t-shirt business (BulkPlainTshirt.com / sale91.com).

RULES:
- Reply in the buyer's language. If they write Hindi, reply in Hindi. If English, reply in English. If Hinglish, reply in Hinglish.
- Be friendly, professional, and helpful. Sound like a real person, not a robot.
- Keep replies SHORT and natural for WhatsApp. Match the length and style of Om's real replies shown in the knowledge base.
- DON'T OVER-QUESTION: When a buyer asks about a product (e.g. "240 gsm catalog dikhao"), share the product info/price directly from the knowledge base. Do NOT ask unnecessary follow-up questions like "kaun sa color?", "kitna quantity?", "kaun sa size?" one by one. Share what you know and let the buyer tell you what they need.
- DON'T BE PUSHY: Never ask "bill bhejoo?", "order karein?", or push the buyer to place an order. Just inform them they can order from sale91.com — ONCE. Let them decide. You are here to inform, not to sell aggressively.
- NEVER REPEAT YOURSELF: If you already mentioned sale91.com or a price in the conversation, don't repeat it. Check the conversation history before replying. One mention is enough.
- HINDI POLITENESS (CRITICAL): Always use polite "aap" verb forms with customers. NEVER use informal "tu/tum" forms.
  WRONG: "bata", "kar", "de", "bhej", "dekh", "bol", "sun", "le", "ja", "aa", "ruk", "baith"
  RIGHT: "bataaiye", "kariye", "dijiye", "bhejiye", "dekhiye", "boliye", "suniye", "lijiye", "jaaiye", "aaiye", "rukiye", "baithiye"
- Never make up information. Only use the knowledge provided below.
- If you don't have enough info in the knowledge base to answer accurately, respond with EXACTLY: [DEFER]
- ORDER-RELATED REQUESTS — respond with EXACTLY: [DEFER] for ANY of these. You CANNOT check orders, look up order details, add/remove items, or do anything with orders. Only Ketu can handle these:
  • Add/remove/change items in an existing order
  • Check order status, order details, order number lookup
  • Replace damaged/defective items
  • Change delivery address, cancel order, modify order in any way
  • Buyer shares an order number, bill number, or invoice — you cannot look these up
  NEVER say "main check kar lunga", "5 min wait karo", "ruko check karta hu" — you cannot check anything. Just [DEFER].
- CONVERSATION ENDERS — respond with EXACTLY: [SKIP] for thank-you, acknowledgment, or goodbye messages (e.g. "thanks", "ok done", "bye", "theek hai"). The conversation is over, do NOT continue it.
- Our prices are FIXED. Never offer discounts.
- Mention sale91.com ONCE per conversation to inform the buyer they can order directly. Check conversation history — if already mentioned, do NOT repeat it. Just inform, never push.
- Do NOT make up prices, product details, or policies. Only use info from the knowledge base provided.
- Never reveal you are an AI. You are Ketu's assistant.`

// Claude pricing (Haiku 4.5 — cheapest for high volume)
const PRICE_PER_INPUT_TOKEN = 0.000001   // $1 per 1M input tokens
const PRICE_PER_OUTPUT_TOKEN = 0.000005  // $5 per 1M output tokens
const USD_TO_INR = 85

/**
 * Main processing function — called after message merge window closes
 */
export async function processIncomingMessage({ whatsappNumber, messages, db, anthropic, settings }) {
  const startTime = Date.now()

  // Check existing conversation BEFORE updating lastMessageAt (needed for welcome bypass)
  const existingConversation = await db.buyerConversation.findUnique({
    where: { whatsappNumber },
    select: { lastMessageAt: true, isFirstTime: true },
  })
  const previousLastMessageAt = existingConversation?.lastMessageAt || null

  // Get or create buyer conversation (this overwrites lastMessageAt to "now")
  // Always set isFirstTime to false on update — if record exists, buyer is not first-time
  const conversation = await db.buyerConversation.upsert({
    where: { whatsappNumber },
    update: {
      lastMessageAt: new Date(),
      messageCount: { increment: messages.length },
      isFirstTime: false,
    },
    create: {
      whatsappNumber,
      lastMessageAt: new Date(),
      messageCount: messages.length,
    },
  })

  const messageIds = messages.map(m => m.messageId)
  const hasTextMessages = messages.some(m => m.messageType === 'text' && m.messageText?.trim())
  const hasAnyText = messages.some(m => m.messageText?.trim())
  const hasMediaOnly = !hasAnyText && messages.some(m => m.hasMedia || m.messageType !== 'text')
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

  // --- Check: Emoji reaction (👍, ❤️, etc.) — skip silently ---
  const isReaction = messages.every(m =>
    m.messageType === 'reaction' ||
    (m.messageText && m.messageText.startsWith('[Reacted:'))
  )
  if (isReaction) {
    await createLog(db, conversation.id, mergedText || '[reaction]', messageIds, {
      status: 'SKIPPED',
      deferReason: 'emoji_reaction',
      processingMs: Date.now() - startTime,
    })
    return
  }

  // --- Check: Cooldown (Om intervened) — must be before media check ---
  if (conversation.cooldownUntil && new Date() < new Date(conversation.cooldownUntil)) {
    await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
      status: 'COOLDOWN',
      deferReason: 'cooldown',
      processingMs: Date.now() - startTime,
    })
    return
  }

  // --- Check: Media-only message (actual image/audio/video/document) ---
  if (hasMediaOnly) {
    // Bill/invoice PDFs from website orders → acknowledge dispatch
    const isBillDocument = mergedText.match(/\[Document:.*BillNo.*\.pdf\]/i)
    const mediaReply = isBillDocument
      ? 'Ok noted sir, dispatching ASAP 🚚'
      : settings.mediaMessage
    await sendReplyViaWwbun(whatsappNumber, mediaReply)
    await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
      status: 'REPLIED',
      aiReply: mediaReply,
      deferReason: isBillDocument ? 'bill_document' : 'media_only',
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

  // --- Check: Repeat message detection ---
  // If same buyer sent the same (or very similar) message recently and AI already replied, skip
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
  const recentReply = await db.messageLog.findFirst({
    where: {
      conversationId: conversation.id,
      status: 'REPLIED',
      buyerMessage: mergedText.trim(),
      createdAt: { gte: fiveMinAgo },
    },
    select: { id: true },
  })
  if (recentReply) {
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'SKIPPED',
      deferReason: 'repeat_message',
      processingMs: Date.now() - startTime,
    })
    console.log(`[Repeat] ${whatsappNumber} — same message already replied to within 5 min, skipping`)
    return
  }

  // --- Normalize text for keyword matching ---
  // Strip trailing honorifics (sir, ji, bhai, boss) before matching
  const normalizedText = mergedText.trim().toLowerCase()
    .replace(/[.!?,।]+$/g, '')
    .trim()
    .replace(/\s+(sir|ji|bhai|bhaiya|boss|bro|sahab|saheb|g)$/i, '')
    .trim()

  // Normalized for greeting detection (also strip emojis)
  const normalizedForGreeting = mergedText.trim().toLowerCase()
    .replace(/[.!?,।🙏👋]+/g, '')
    .trim()

  // --- Dynamic Pre-AI Keyword Filters ---
  // Load from DB (cached 5 min). Falls back to hardcoded if DB not ready.
  const dynamicFilters = await loadKeywordFilters(db)
  let isGreeting = false

  if (dynamicFilters) {
    // === DYNAMIC PATH: filters from database ===
    for (const filter of dynamicFilters) {
      // For exact match filters, use normalizedText (honorifics stripped)
      // For greeting, use normalizedForGreeting (emojis also stripped)
      const textForMatch = filter.name === 'greeting' ? normalizedForGreeting : normalizedText
      const lowerMsg = mergedText.trim().toLowerCase()
      const matched = checkKeywordMatch(textForMatch, lowerMsg, filter)

      if (!matched) continue

      if (filter.action === 'skip') {
        await createLog(db, conversation.id, mergedText, messageIds, {
          status: 'SKIPPED',
          deferReason: filter.name,
          processingMs: Date.now() - startTime,
        })
        console.log(`[${filter.displayName}] ${whatsappNumber} — skipped, 0 tokens`)
        return
      }

      if (filter.action === 'defer') {
        await sendReplyViaWwbun(whatsappNumber, settings.deferMessage)
        await createLog(db, conversation.id, mergedText, messageIds, {
          status: 'DEFERRED',
          deferReason: filter.name,
          aiReply: settings.deferMessage,
          processingMs: Date.now() - startTime,
          sentViaWwbun: true,
        })
        console.log(`[${filter.displayName}] ${whatsappNumber} — deferred to Ketu`)
        return
      }

      if (filter.action === 'auto_reply') {
        const replyText = filter.autoReplyText || 'Ok noted sir 👍'
        await sendReplyViaWwbun(whatsappNumber, replyText)
        await createLog(db, conversation.id, mergedText, messageIds, {
          status: 'REPLIED',
          deferReason: filter.name,
          aiReply: replyText,
          processingMs: Date.now() - startTime,
          sentViaWwbun: true,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        })
        console.log(`[${filter.displayName}] ${whatsappNumber} — auto-replied, 0 tokens`)
        return
      }

      if (filter.action === 'welcome_bypass') {
        isGreeting = true
        // Don't return — greeting has special welcome flow below
        break
      }
    }
  } else {
    // === HARDCODED FALLBACK: DB not ready (migration not run) ===
    const ackPatterns = [
      'ok', 'okay', 'fine', 'sure', 'thanks', 'thank you', 'alright',
      'got it', 'noted', 'understood', 'no problem', 'np', 'cool',
      'great', 'good', 'right', 'yes', 'yep', 'ya', 'yaa',
      'theek hai', 'thik hai', 'accha', 'acha', 'sahi hai',
      'ji', 'haan', 'ha', 'dhanyavaad', 'shukriya', 'bas',
      'theek', 'thik', 'achchha', 'hmm', 'hm', 'k', 'kk',
      'done', 'bilkul', 'zaroor', 'thx', 'ty',
    ]
    if (ackPatterns.includes(normalizedText)) {
      await createLog(db, conversation.id, mergedText, messageIds, {
        status: 'SKIPPED',
        deferReason: 'acknowledgment',
        processingMs: Date.now() - startTime,
      })
      return
    }

    const greetingPatterns = [
      'hi', 'hello', 'hey', 'hii', 'hiii', 'hiiii',
      'helo', 'hllo', 'helloo', 'hellooo',
      'namaste', 'namaskar', 'namaskaar',
      'good morning', 'good afternoon', 'good evening',
      'gm', 'morning', 'evening',
      'hy', 'hye', 'hola', 'yo',
    ]
    isGreeting = greetingPatterns.includes(normalizedForGreeting)
  }

  // --- WELCOME MESSAGE BYPASS ---
  // ONLY for greetings ("hi", "hello", etc.) from first-time buyers or returning after 7+ days
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
  const lastMessageAge = previousLastMessageAt
    ? Date.now() - new Date(previousLastMessageAt).getTime()
    : Infinity
  const isFirstTime = !existingConversation
  let shouldSendWelcome = isGreeting && (isFirstTime || lastMessageAge > SEVEN_DAYS_MS)

  // Extra safety: check message logs too — if there are recent logs (within 7 days), don't send welcome
  if (shouldSendWelcome && !isFirstTime) {
    const recentLog = await db.messageLog.findFirst({
      where: {
        conversationId: conversation.id,
        createdAt: { gt: new Date(Date.now() - SEVEN_DAYS_MS) },
      },
      select: { id: true },
    })
    if (recentLog) {
      shouldSendWelcome = false
      console.log(`[Welcome] ${whatsappNumber} — skipped: recent message log found despite old lastMessageAt`)
    }
  }

  if (shouldSendWelcome) {
    const welcomeChunk = await db.knowledgeChunk.findFirst({
      where: { source: 'SAVED_REPLY', sourceId: 'welcome' },
      select: { content: true },
    })
    // Strip shortcut prefix (e.g. "/welcome: ") from stored content
    let welcomeMessage = welcomeChunk?.content || 'https://sale91.com/catalog\n\nCheck rates, color and buy 👆'
    welcomeMessage = welcomeMessage.replace(/^\/\w+:\s*/, '')
    await sendReplyViaWwbun(whatsappNumber, welcomeMessage)
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'REPLIED',
      aiReply: welcomeMessage,
      deferReason: 'welcome_bypass',
      processingMs: Date.now() - startTime,
      sentViaWwbun: true,
    })
    console.log(`[Welcome] ${whatsappNumber} — direct welcome, 0 tokens`)
    return
  }

  // --- Check: Order ID / tracking number detection ---
  const trimmedText = mergedText.trim()
  const isOrderId = /^\d{10,}$/.test(trimmedText)
  if (isOrderId) {
    await sendReplyViaWwbun(whatsappNumber, settings.deferMessage)
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'DEFERRED',
      deferReason: 'order_id_detected',
      aiReply: settings.deferMessage,
      processingMs: Date.now() - startTime,
      sentViaWwbun: true,
    })
    console.log(`[OrderID] ${whatsappNumber} — detected order/tracking ID, deferred to Ketu`)
    return
  }

  // --- VECTOR SEARCH: Single search across all 4 knowledge sources ---
  // Catalog + Reply Templates + Style Pairs (337 Q&A pairs) + Corrections (Om's edits) — top 5 overall
  // Style Guide excluded (it's a compact summary, not a searchable chunk)
  const allVectorResults = await vectorSearch(db, anthropic, mergedText, {
    limit: 5,
    minSimilarity: 0.0,
    excludeSources: ['STYLE_GUIDE'],
  })

  const bestSimilarity = allVectorResults.length > 0
    ? Math.max(...allVectorResults.map(r => Number(r.similarity)))
    : 0

  // All top 5 results go to the user prompt as knowledge (style pairs are both knowledge AND style reference)
  const knowledgeResults = allVectorResults
  const stylePairResults = [] // no longer separated — all results treated as knowledge

  console.log(`[Vector] ${whatsappNumber} — ${allVectorResults.length} results (top 5 from all 3 sources), best: ${(bestSimilarity * 100).toFixed(1)}%`)

  // All messages go to Claude — Claude decides: reply, [DEFER], or [SKIP]

  // --- Build prompt for Claude ---
  // Get recent conversation history (last 5 messages)
  const recentLogs = await db.messageLog.findMany({
    where: { conversationId: conversation.id, status: 'REPLIED' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { buyerMessage: true, aiReply: true },
  })
  const conversationHistory = recentLogs.reverse()

  // Fetch Om's extracted style guide (compact, ~200 words)
  const styleGuideChunk = await db.knowledgeChunk.findFirst({
    where: { source: 'STYLE_GUIDE', sourceId: 'om_style_guide' },
    select: { content: true },
  })
  const styleGuide = styleGuideChunk?.content || null

  const systemPrompt = buildSystemPrompt({ settings, styleGuide, stylePairs: stylePairResults })
  const userPrompt = buildUserPrompt({
    mergedText,
    knowledgeResults,
    stylePairResults,
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
      knowledgeChunks: allVectorResults.map(c => ({ title: c.title, source: c.source, similarity: Number(c.similarity).toFixed(3) })),
      processingMs: Date.now() - startTime,
    })
    return
  }

  // --- Check if Claude detected a conversation ender (thanks, bye, etc.) ---
  if (aiReply.includes('[SKIP]')) {
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'SKIPPED',
      deferReason: 'conversation_ended',
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd,
      processingMs: Date.now() - startTime,
    })
    await db.settings.update({
      where: { id: 'default' },
      data: { dailySpentUsd: { increment: costUsd } },
    })
    await autoLearnAcknowledgment(db, normalizedText)
    console.log(`[Skip] ${whatsappNumber} — conversation ender detected by Claude`)
    return
  }

  // --- Check if Claude deferred (couldn't answer from knowledge base) ---
  const DEFER_MARKER = '[DEFER]'
  if (aiReply.includes(DEFER_MARKER)) {
    await sendReplyViaWwbun(whatsappNumber, settings.deferMessage)
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'DEFERRED',
      deferReason: 'claude_deferred',
      aiReply: settings.deferMessage,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd,
      processingMs: Date.now() - startTime,
      sentViaWwbun: true,
    })
    // Update daily spend even for deferred (Claude API was called)
    await db.settings.update({
      where: { id: 'default' },
      data: { dailySpentUsd: { increment: costUsd } },
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

  // --- Log ---
  const catalogMatches = knowledgeResults.filter(c => c.source === 'CATALOG')
  await createLog(db, conversation.id, mergedText, messageIds, {
    status: 'REPLIED',
    aiReply,
    knowledgeChunks: allVectorResults.map(c => ({ title: c.title, source: c.source, similarity: Number(c.similarity).toFixed(3) })),
    similarityScore: bestSimilarity,
    catalogMatch: catalogMatches.length > 0 ? catalogMatches[0].metadata : null,
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

// (Old keyword-based chunk filtering removed — now using vector search)

// ===========================================
// Prompt Building (Vector-based v2)
// ===========================================

function buildSystemPrompt({ settings, styleGuide, stylePairs }) {
  // Use dashboard-editable system prompt if available, otherwise hardcoded default
  let prompt = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT

  // Om's extracted style guide (compact — extracted once from 337 real reply pairs)
  if (styleGuide) {
    prompt += `\n\nOM'S COMMUNICATION STYLE:\n${styleGuide}`
  }

  return prompt
}

function buildUserPrompt({ mergedText, knowledgeResults, stylePairResults, conversationHistory }) {
  let prompt = ''

  // Knowledge results from vector search (top 5 matches from catalog + templates + policies)
  if (knowledgeResults.length > 0) {
    prompt += `KNOWLEDGE BASE (top matches for this question — use this info to answer):\n`
    for (const result of knowledgeResults) {
      const sim = (Number(result.similarity) * 100).toFixed(0)
      prompt += `---\n[${result.source}] ${result.title || ''} (${sim}% match)\n${result.content}\n`
      if (result.source === 'CATALOG' && result.metadata) {
        const meta = typeof result.metadata === 'string' ? JSON.parse(result.metadata) : result.metadata
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
