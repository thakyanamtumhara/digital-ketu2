// Core message processing pipeline
// Handles: merge → dedup → media check → cooldown → defer check → all chunks → Claude → reply

import { getAllChunks, vectorSearchDeferList } from './embeddings.js'

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

  // --- Check: Media-only message (actual image/audio/video/document) ---
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

  // --- Check: Acknowledgment messages — always skip ---
  // If buyer just says ok/okay/hmm etc., AI should stay silent regardless of context
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
      deferReason: 'acknowledgment',
      processingMs: Date.now() - startTime,
    })
    return
  }

  // --- Check: Is this a greeting? Skip defer-to-ketu for greetings ---
  const greetingPatterns = [
    'hi', 'hello', 'hey', 'hii', 'hiii', 'hiiii',
    'helo', 'hllo', 'helloo', 'hellooo',
    'namaste', 'namaskar', 'namaskaar',
    'good morning', 'good afternoon', 'good evening',
    'gm', 'morning', 'evening',
    'hy', 'hye', 'hola', 'yo',
  ]
  const normalizedForGreeting = mergedText.trim().toLowerCase()
    .replace(/[.!?,।🙏👋]+/g, '')
    .trim()
  const isGreeting = greetingPatterns.includes(normalizedForGreeting)

  // --- WELCOME MESSAGE BYPASS ---
  // First-time buyer OR returning after 7+ days → send welcome message directly, no Claude call
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
  const lastMessageAge = previousLastMessageAt
    ? Date.now() - new Date(previousLastMessageAt).getTime()
    : Infinity
  // Only truly first-time if no conversation exists at all (no previousLastMessageAt)
  // If buyer has messaged before (has lastMessageAt), only send welcome if 7+ days gap
  const isFirstTime = !existingConversation
  const shouldSendWelcome = isFirstTime || lastMessageAge > SEVEN_DAYS_MS

  if (shouldSendWelcome) {
    // Fetch the /welcome saved reply from knowledge base
    const welcomeChunk = await db.knowledgeChunk.findFirst({
      where: { source: 'SAVED_REPLY', sourceId: 'welcome' },
      select: { content: true },
    })
    const welcomeMessage = welcomeChunk?.content || 'https://sale91.com/catalog\n\nCheck rates, color and buy 👆'

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

  // --- Check: Defer to Ketu list (skip for greetings) ---
  // If a correction exists (correctReply), use it directly instead of deferring
  if (!isGreeting) {
    const deferMatch = await vectorSearchDeferList(db, anthropic, mergedText, {
      threshold: settings.deferThreshold,
    })
    if (deferMatch) {
      // Increment trigger count
      await db.deferToKetu.update({
        where: { id: deferMatch.id },
        data: { triggerCount: { increment: 1 } },
      })

      // If Om provided a corrected reply, use it directly (no defer, no Claude call)
      if (deferMatch.correctReply) {
        await sendReplyViaWwbun(whatsappNumber, deferMatch.correctReply)
        await createLog(db, conversation.id, mergedText, messageIds, {
          status: 'REPLIED',
          deferReason: null,
          similarityScore: deferMatch.similarity,
          aiReply: deferMatch.correctReply,
          processingMs: Date.now() - startTime,
          sentViaWwbun: true,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        })
        console.log(`[CorrectedReply] ${whatsappNumber} — used Om's correction, 0 tokens`)
        return
      }

      // No corrected reply — defer to Ketu
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
  }

  // --- Fetch knowledge chunks (SMART FILTERING to reduce tokens) ---
  const allChunks = await getAllChunks(db)

  // If KB is completely empty, defer (sync hasn't run yet)
  if (allChunks.length === 0) {
    await sendReplyViaWwbun(whatsappNumber, settings.deferMessage)
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'DEFERRED',
      deferReason: 'empty_knowledge_base',
      aiReply: settings.deferMessage,
      processingMs: Date.now() - startTime,
      sentViaWwbun: true,
    })
    return
  }

  // --- Smart chunk selection based on message intent ---
  // Instead of sending ALL 82 chunks (~8000 tokens), pick what's relevant (~2000-3000 tokens)
  const filteredChunks = filterChunksForMessage(allChunks, mergedText, isGreeting)

  // --- Build prompt for Claude ---
  // isFirstTime is always false here — welcome bypass already returned above

  // Get recent conversation history (last 5 messages)
  const recentLogs = await db.messageLog.findMany({
    where: { conversationId: conversation.id, status: 'REPLIED' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { buyerMessage: true, aiReply: true },
  })
  const conversationHistory = recentLogs.reverse()

  // Fetch Om's real reply style from defer-to-ketu corrections
  const deferExamples = await db.deferToKetu.findMany({
    select: { buyerQuestion: true, correctReply: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })

  // Fetch Om's extracted style guide (compact, ~200 words instead of raw pairs)
  const styleGuideChunk = await db.knowledgeChunk.findFirst({
    where: { source: 'STYLE_GUIDE', sourceId: 'om_style_guide' },
    select: { content: true },
  })
  const styleGuide = styleGuideChunk?.content || null

  // Separate catalog chunks for display
  const catalogChunks = filteredChunks.filter(c => c.source === 'CATALOG')
  const otherChunks = filteredChunks.filter(c => c.source !== 'CATALOG')

  // Detect dispatch intent: buyer says payment done + wants dispatch
  const dispatchKeywords = ['dispatch', 'nikal', 'bhej', 'ship', 'send', 'deliver', 'courier']
  const paymentKeywords = ['payment', 'paid', 'pay', 'paisa', 'paise', 'amount', 'transfer']
  const urgencyKeywords = ['abhi', 'aaj', 'now', 'today', 'jaldi', 'asap', 'urgent', 'turant']
  const lowerMsg = mergedText.toLowerCase()
  const hasDispatchIntent = (
    dispatchKeywords.some(kw => lowerMsg.includes(kw)) ||
    (paymentKeywords.some(kw => lowerMsg.includes(kw)) && urgencyKeywords.some(kw => lowerMsg.includes(kw)))
  )

  // Detect buying intent: buyer asking about price, ordering, MOQ, samples etc.
  const buyingIntentKeywords = [
    'price', 'rate', 'cost', 'kitna', 'kitne', 'kya rate', 'bhav', 'daam',
    'order', 'buy', 'kharidna', 'lena', 'chahiye', 'mangta',
    'moq', 'minimum', 'bulk', 'wholesale',
    'sample', 'catalog', 'catalogue',
    'how to order', 'kaise order', 'order kaise',
  ]
  const hasBuyingIntent = buyingIntentKeywords.some(kw => lowerMsg.includes(kw))

  const systemPrompt = buildSystemPrompt({ isFirstTime: false, settings, deferExamples, styleGuide, hasDispatchIntent, hasBuyingIntent })
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
      knowledgeChunks: filteredChunks.map(c => ({ title: c.title, source: c.source })),
      processingMs: Date.now() - startTime,
    })
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
  await createLog(db, conversation.id, mergedText, messageIds, {
    status: 'REPLIED',
    aiReply,
    knowledgeChunks: filteredChunks.map(c => ({ title: c.title, source: c.source })),
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
// Smart Chunk Filtering (token optimization)
// ===========================================
// Instead of sending ALL 82 chunks (~8000 tokens), pick relevant ones (~2000-3000)

function filterChunksForMessage(allChunks, message, isGreeting) {
  const lower = message.toLowerCase()
  const policies = allChunks.filter(c => c.source === 'POLICY')
  const catalog = allChunks.filter(c => c.source === 'CATALOG')
  const savedReplies = allChunks.filter(c => c.source === 'SAVED_REPLY')

  // Always include: policies (small, always relevant)
  const selected = [...policies]

  // For greetings: just policies (welcome already handled by bypass)
  if (isGreeting) {
    return selected
  }

  // Product-related keywords → include catalog
  const productKeywords = [
    'tshirt', 't-shirt', 't shirt', 'hoodie', 'sweatshirt', 'polo', 'round neck',
    'oversize', 'oversized', 'drop shoulder', 'jacket', 'varsity', 'shorts',
    'kids', 'cotton', 'polyester', 'gsm', 'fabric', 'sublimation', 'acid wash',
    'acidwash', 'biowash', 'zip', 'hoodie', 'jogger', 'bottom',
    'price', 'rate', 'cost', 'kitna', 'kitne', 'kya rate', 'bhav', 'daam',
    'color', 'colour', 'rang', 'size', 'sizes',
    'catalog', 'catalogue', 'product', 'products', 'collection', 'range',
    'sample', 'order', 'bulk', 'wholesale', 'moq', 'minimum',
    'buy', 'kharidna', 'lena', 'chahiye', 'mangta', 'bhejo', 'ship',
  ]
  const needsCatalog = productKeywords.some(kw => lower.includes(kw))

  // Logistics/business keywords → include relevant saved replies
  const logisticsKeywords = [
    'delivery', 'shipping', 'dispatch', 'track', 'tracking', 'courier',
    'payment', 'pay', 'upi', 'bank', 'account', 'prepaid',
    'gst', 'bill', 'invoice', 'tax',
    'return', 'exchange', 'refund', 'cancel',
    'printer', 'printing', 'embroidery', 'custom', 'customize',
    'pickup', 'tiruppur', 'address', 'location', 'where',
    'discount', 'offer', 'deal',
    'cod', 'cash on delivery',
    'time', 'kitne din', 'kab', 'when',
  ]
  const needsLogistics = logisticsKeywords.some(kw => lower.includes(kw))

  if (needsCatalog) {
    // General catalog keywords → send all products
    const generalCatalogKeywords = [
      'catalog', 'catalogue', 'product', 'products', 'collection', 'range',
      'kya kya hai', 'sab dikhao', 'all products', 'full list', 'what all',
    ]
    const wantsFullCatalog = generalCatalogKeywords.some(kw => lower.includes(kw))

    if (wantsFullCatalog) {
      selected.push(...catalog)
    } else {
      // Smart match: only send products matching buyer's query
      const matchedProducts = catalog.filter(product => {
        const titleLower = (product.title || '').toLowerCase()
        const contentLower = (product.content || '').toLowerCase()
        const meta = product.metadata
          ? (typeof product.metadata === 'string' ? JSON.parse(product.metadata) : product.metadata)
          : {}
        const colorsStr = (meta.colors || []).join(' ').toLowerCase()
        const categoryStr = (meta.category || '').toLowerCase()

        // Check product name, content, colors, category against buyer's words
        const words = lower.split(/\s+/).filter(w => w.length > 2)
        return words.some(w =>
          titleLower.includes(w) || contentLower.includes(w) ||
          colorsStr.includes(w) || categoryStr.includes(w)
        )
      })

      // If specific products matched, send only those; otherwise send all as fallback
      if (matchedProducts.length > 0) {
        selected.push(...matchedProducts)
      } else {
        selected.push(...catalog)
      }
    }
  }

  if (needsLogistics || needsCatalog) {
    // Include saved replies that match keywords in the message
    const relevantReplies = savedReplies.filter(sr => {
      const titleLower = (sr.title || '').toLowerCase()
      const contentLower = (sr.content || '').toLowerCase()
      // Check if any word in the buyer's message appears in this saved reply
      const words = lower.split(/\s+/).filter(w => w.length > 3)
      return words.some(w => titleLower.includes(w) || contentLower.includes(w))
    })
    selected.push(...relevantReplies)
  }

  // If nothing specific matched, include catalog + policies (general product inquiry)
  if (selected.length <= policies.length) {
    selected.push(...catalog)
  }

  // Deduplicate
  const seen = new Set()
  return selected.filter(c => {
    const key = `${c.source}:${c.sourceId || c.title}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ===========================================
// Prompt Building
// ===========================================

function buildSystemPrompt({ isFirstTime, settings, deferExamples, styleGuide, hasDispatchIntent, hasBuyingIntent }) {
  let prompt = `You are Ketu's assistant — an AI that replies to WhatsApp buyers for a wholesale blank t-shirt business (BulkPlainTshirt.com / sale91.com).

RULES:
- Reply in the buyer's language. If they write Hindi, reply in Hindi. If English, reply in English. If Hinglish, reply in Hinglish.
- Be friendly, professional, and helpful. Sound like a real person, not a robot.
- Keep replies SHORT — max 10-15 words. WhatsApp replies should be quick, direct, and to the point. No long paragraphs.
- Match Ketu's style: casual, friendly, uses simple words. Look at the STYLE EXAMPLES below.
- Never make up information. Only use the knowledge provided below.
- If you don't have enough info in the knowledge base to answer accurately, respond with EXACTLY: [DEFER]
- Do NOT make up prices, product details, or policies. Only use info from the knowledge base provided.
- Never reveal you are an AI. You are Ketu's assistant.
- Use natural greetings appropriate to the language (Namaste, Hello, Hi, etc.).`

  // Dispatch intent: only add dispatch rule when buyer is asking about dispatch/shipping after payment
  if (hasDispatchIntent) {
    prompt += `\n\nDISPATCH RULE (IMPORTANT — follow this strictly):
- When buyer's intention is "payment done, please dispatch" or "abhi nikal do" or "aaj hi chahiye" — simply reassure them: "Abhi nikal raha hu sir, thoda time dijiye" (I will dispatch now, give me some time). Do NOT say "kal nikal jaayega" or give future dates. Just confirm immediate dispatch.
- If buyer keeps asking too many follow-up questions about dispatch (tracking, exact time, repeated asking) — respond with [DEFER] so Ketu can handle it personally.`
  }

  // Buying intent: only add sale91 rule when buyer is asking about pricing/ordering
  if (hasBuyingIntent) {
    prompt += `\n\nSALE91 RULE:
- Mention sale91.com ONLY ONCE. Check the conversation history — if sale91.com was already shared in a previous reply, do NOT repeat it. Just answer the buyer's question directly. Don't force it.`
  }

  // Add Om's real reply style examples from defer-to-ketu corrections
  if (deferExamples && deferExamples.length > 0) {
    prompt += `\n\nSTYLE EXAMPLES (this is how Ketu actually replies — match this tone, length, and word choice):`
    for (const ex of deferExamples.slice(0, 10)) {
      prompt += `\nBuyer: "${ex.buyerQuestion}" → Ketu: "${ex.correctReply}"`
    }
  }

  // Add Om's extracted style guide (compact — extracted once from 200 real reply pairs)
  if (styleGuide) {
    prompt += `\n\nOM'S COMMUNICATION STYLE (extracted from real WhatsApp conversations):\n${styleGuide}`
  }

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
