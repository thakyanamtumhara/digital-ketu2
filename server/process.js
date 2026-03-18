// Core message processing pipeline
// Handles: merge → dedup → pre-AI filters → vector search → Claude → reply
//
// Pipeline:
// 1. Pre-AI filters (exact matches, system checks) → zero cost
// 2. Buyer message → Voyage AI embedding → vector search (top 5 from all sources)
// 3. ALL messages sent to Claude with knowledge context
// 4. Claude decides: reply, [DEFER] to Ketu, or [SKIP] conversation ender

import { vectorSearch } from './embeddings.js'

// ===========================================
// Welcome Follow-Up Constants & State
// ===========================================
const THREE_MINUTES_MS = 3 * 60 * 1000
const DEFER_DELAY_MS = 30 * 1000 // 30 seconds — batch defers before sending
const WELCOME_FOLLOWUP_GENERIC = 'Ask me if any questions sir?'
export const pendingWelcomeFollowups = new Map() // keyed by whatsappNumber
export const pendingDefers = new Map() // keyed by whatsappNumber

// ===========================================
// Defer Batching: Wait 30s, batch multiple defers into one message
// ===========================================
function scheduleDeferReply({ whatsappNumber, deferMessage, conversationId, mergedText, messageIds, logData, db }) {
  const existing = pendingDefers.get(whatsappNumber)
  const messageEntry = { conversationId, mergedText, messageIds, logData }

  if (existing) {
    clearTimeout(existing.timer)
    existing.messages.push(messageEntry)
  } else {
    pendingDefers.set(whatsappNumber, {
      messages: [messageEntry],
      deferMessage,
      db,
    })
  }

  const entry = pendingDefers.get(whatsappNumber)
  entry.timer = setTimeout(createDeferTimerCallback(whatsappNumber), DEFER_DELAY_MS)

  console.log(`[DeferBatch] ${whatsappNumber} — scheduled defer in 30s (${entry.messages.length} message(s) batched)`)
}

function createDeferTimerCallback(whatsappNumber) {
  return async () => {
    const entry = pendingDefers.get(whatsappNumber)
    if (!entry) return
    pendingDefers.delete(whatsappNumber)

    try {
      // Re-check cooldown before sending
      const freshConvo = await entry.db.buyerConversation.findUnique({
        where: { whatsappNumber },
        select: { cooldownUntil: true },
      })
      if (freshConvo?.cooldownUntil && new Date() < new Date(freshConvo.cooldownUntil)) {
        console.log(`[DeferBatch] ${whatsappNumber} — skipped: cooldown active`)
        for (const msg of entry.messages) {
          await createLog(entry.db, msg.conversationId, msg.mergedText, msg.messageIds, {
            status: 'COOLDOWN',
            deferReason: 'cooldown',
            processingMs: 0,
          })
        }
        return
      }

      // Send ONE defer message for all batched messages
      await sendReplyViaWwbun(whatsappNumber, entry.deferMessage)

      // Log each accumulated message
      for (const msg of entry.messages) {
        await createLog(entry.db, msg.conversationId, msg.mergedText, msg.messageIds, {
          ...msg.logData,
          aiReply: entry.deferMessage,
          sentViaWwbun: true,
        })
      }

      console.log(`[DeferBatch] ${whatsappNumber} — sent ONE defer for ${entry.messages.length} message(s)`)
    } catch (err) {
      console.error(`[DeferBatch Error] ${whatsappNumber}:`, err.message)
    }
  }
}

function cancelPendingDefer(whatsappNumber) {
  const pending = pendingDefers.get(whatsappNumber)
  if (pending) {
    clearTimeout(pending.timer)
    pendingDefers.delete(whatsappNumber)
    console.log(`[DeferBatch] ${whatsappNumber} — cancelled pending defer (AI replied)`)
  }
}

function restartDeferTimer(whatsappNumber) {
  const entry = pendingDefers.get(whatsappNumber)
  if (entry && !entry.timer) {
    entry.timer = setTimeout(createDeferTimerCallback(whatsappNumber), DEFER_DELAY_MS)
    console.log(`[DeferBatch] ${whatsappNumber} — restarted defer timer`)
  }
}

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

// ===========================================
// Invoice/Bill Image Detection (Claude Vision)
// ===========================================
async function isInvoiceImage(anthropic, mediaUrl) {
  if (!mediaUrl) return false
  try {
    // Fetch the image/document from wwbun storage
    const response = await fetch(mediaUrl)
    if (!response.ok) {
      console.log('[InvoiceDetect] Failed to fetch media:', response.status)
      return false
    }
    const buffer = await response.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')
    const contentType = response.headers.get('content-type') || 'image/jpeg'

    // Build content block based on media type (image or PDF document)
    let mediaContent
    if (contentType.startsWith('image/')) {
      mediaContent = {
        type: 'image',
        source: { type: 'base64', media_type: contentType, data: base64 },
      }
    } else if (contentType === 'application/pdf') {
      mediaContent = {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      }
    } else {
      // Unsupported content type
      console.log(`[InvoiceDetect] Unsupported content type: ${contentType}`)
      return false
    }

    const result = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: [
          mediaContent,
          {
            type: 'text',
            text: 'Is this a purchase bill, tax invoice, or order receipt? Reply only YES or NO.',
          },
        ],
      }],
    })
    const answer = result.content?.[0]?.text?.trim().toUpperCase() || ''
    console.log(`[InvoiceDetect] Vision result: ${answer}`)
    return answer.startsWith('YES')
  } catch (err) {
    console.error('[InvoiceDetect] Detection error:', err.message)
    return false
  }
}

// ===========================================
// Message Classification (generic vs real question)
// ===========================================
function isGenericMessage(text) {
  if (!text || !text.trim()) return true
  const normalized = text.trim().toLowerCase()
    .replace(/[.!?,।🙏👋]+/g, '')
    .trim()
    .replace(/\s+(sir|ji|bhai|bhaiya|boss|bro|sahab|saheb|g)$/i, '')
    .trim()

  // Known greetings
  const greetingPatterns = [
    'hi', 'hello', 'hey', 'hii', 'hiii', 'hiiii',
    'helo', 'hllo', 'helloo', 'hellooo',
    'namaste', 'namaskar', 'namaskaar',
    'good morning', 'good afternoon', 'good evening',
    'gm', 'morning', 'evening', 'hy', 'hye', 'hola', 'yo',
  ]
  if (greetingPatterns.includes(normalized)) return true

  // Generic catalog/detail requests — ONLY if message is short (≤4 words)
  // Longer messages like "I want samples of oversized tshirts and regular tshirts"
  // are real inquiries even if they contain "tshirt" or "details"
  const words = normalized.split(/\s+/).filter(w => w.length > 0)
  const genericPhrases = [
    'share catalog', 'share catalogue', 'send catalog', 'send catalogue',
    'share details', 'send details', 'catalog share', 'catalogue share',
    'catalog bhejo', 'catalogue bhejo', 'details bhejo', 'catalog send',
    'rate list', 'rate card', 'price list', 'catalog', 'catalogue',
    'tshirt', 't shirt', 't-shirt', 'details',
  ]
  if (words.length <= 4 && genericPhrases.some(p => normalized.includes(p))) return true

  // 4 words or fewer without a question indicator → generic
  const hasQuestionMark = text.includes('?')
  const questionWords = [
    'what', 'how', 'when', 'where', 'which', 'why', 'can', 'do', 'is', 'are',
    'kya', 'kaise', 'kab', 'kaha', 'kaun', 'kitna', 'kitne', 'kitni', 'konsa', 'konsi',
  ]
  const hasQuestionWord = questionWords.some(qw => words.includes(qw) || normalized.startsWith(qw))

  if (words.length <= 4 && !hasQuestionMark && !hasQuestionWord) return true

  return false
}

// Default system prompt (used when dashboard systemPrompt field is empty)
export const DEFAULT_SYSTEM_PROMPT = `You are Ketu's assistant — an AI that replies to WhatsApp buyers for a wholesale blank t-shirt business (BulkPlainTshirt.com / sale91.com).

RULES:
- Reply in the buyer's language. If they write Hindi, reply in Hindi. If English, reply in English. If Hinglish, reply in Hinglish.
- Be friendly, professional, and helpful. Sound like a real person, not a robot.
- REPLY LENGTH (CRITICAL): Keep replies 10-15 words MAX. You can go up to 18 words if absolutely needed, but NEVER more. This is WhatsApp, not email. One short sentence is perfect.
- ASK CLARIFYING QUESTIONS WHEN NEEDED: If the buyer's question is vague (e.g. "cream color available hai?"), ask ONE short clarifying question like "Cream kaun se product mein sir?" Do NOT dump all product info. But if the buyer is specific (e.g. "240 gsm oversize rate?"), answer directly — don't ask unnecessary follow-ups like color/size/quantity.
- DON'T BE PUSHY: Never ask "bill bhejoo?", "order karein?", or push the buyer to place an order. Just inform them they can order from sale91.com — ONCE. Let them decide. You are here to inform, not to sell aggressively.
- NEVER REPEAT YOURSELF: If you already mentioned sale91.com or a price in the conversation, don't repeat it. Check the conversation history before replying. One mention is enough.
- HINDI POLITENESS (CRITICAL): Always use polite "aap" verb forms with customers. NEVER use informal "tu/tum" forms.
  WRONG: "bata", "kar", "de", "bhej", "dekh", "bol", "sun", "le", "ja", "aa", "ruk", "baith"
  RIGHT: "bataaiye", "kariye", "dijiye", "bhejiye", "dekhiye", "boliye", "suniye", "lijiye", "jaaiye", "aaiye", "rukiye", "baithiye"
- Never make up information. Only use the knowledge provided below.
- If you don't have enough info in the knowledge base to answer accurately, respond with EXACTLY: [DEFER]
- ORDER CONFIRMATIONS (buyer says "order place kiya", "order ho gaya", "payment done", "dispatch kardo", "porter krwado") — this is NOT a question. Buyer is just informing you. Reply: "Noted sir, dispatch kar denge" or similar acknowledgment. Do NOT defer these.
- ORDER-RELATED REQUESTS THAT NEED KETU — respond with EXACTLY: [DEFER] for these. You CANNOT check orders or do anything with them. Only Ketu can handle:
  • Check order status, order details, order number lookup
  • Add/remove/change items in an existing order
  • Replace damaged/defective items
  • Change delivery address, cancel order, modify order in any way
  • Buyer shares an order number, bill number, or invoice — you cannot look these up
  NEVER say "main check kar lunga", "5 min wait karo", "ruko check karta hu" — you cannot check anything. Just [DEFER].
- CONVERSATION ENDERS — respond with EXACTLY: [SKIP] for thank-you, acknowledgment, or goodbye messages (e.g. "thanks", "ok done", "bye", "theek hai"). The conversation is over, do NOT continue it.
- Our prices are FIXED. Never offer discounts.
- Mention sale91.com ONCE per conversation to inform the buyer they can order directly. Check conversation history — if already mentioned, do NOT repeat it. Just inform, never push.
- Do NOT make up prices, product details, or policies. Only use info from the knowledge base provided.
- Never reveal you are an AI. You are Ketu's assistant.
- QUOTED/TAGGED MESSAGES: If the buyer quotes (tags/replies to) a previous message, treat the quoted message as CONTEXT for their current message. They are ONE thought. If the buyer sends just "..." or dots while quoting a message, they are re-asking the quoted message — respond to the QUOTED message as if it is their question. Never say the message is "incomplete" or "unclear" just because the buyer typed dots.
- NEVER say a buyer's message is "incomplete", "unclear", or ask them to "share the actual message". Always try to understand and respond. If you truly cannot answer, use [DEFER].
- RESTOCK / AVAILABILITY TIMING — respond with EXACTLY: [DEFER] when buyer asks WHEN a product will be back in stock or available again (e.g. "kab tak available hoga", "kab aayega", "kab milega", "restock kab", "wapas kab aayega"). You do NOT know restock dates — only Ketu knows this.
- NO-CONTEXT MESSAGES — respond with EXACTLY: [DEFER] when the buyer's message has no clear connection to products, pricing, or anything in the knowledge base (e.g. "kitne packets hai", "kahan tak aaya", "ho gaya kya", "bhej diya kya", "aaj aa jayega kya", "porter has been reached"). These are about an ongoing order or delivery that only Ketu can handle. Do NOT guess what they mean. Do NOT ask clarifying questions like "kis product ke?". Just [DEFER].
- CONTINUE DEFERRING — If the recent conversation history shows messages were [DEFERRED TO KETU], that means Ketu is actively handling something with this buyer. Continue responding with [DEFER] for follow-up messages UNLESS the buyer clearly starts a brand new topic (e.g. asking about a specific product name or price). When in doubt, [DEFER].
- STRICT CATALOG DATA — NEVER invent product details. Only mention GSMs, sizes, colors, and prices that appear in the KNOWLEDGE BASE results for this query. Our GSMs are: 180, 200, 210, 220, 240, 320, 430. We do NOT sell 150 GSM. Max adult size is XXL (no 3XL, 4XL, 5XL). If the knowledge base doesn't list a specific detail, don't guess — either use [DEFER] or ask the buyer to check sale91.com.`

// Claude pricing (Haiku 4.5 — cheapest for high volume)
const PRICE_PER_INPUT_TOKEN = 0.000001   // $1 per 1M input tokens
const PRICE_PER_OUTPUT_TOKEN = 0.000005  // $5 per 1M output tokens
const USD_TO_INR = 85

/**
 * Main processing function — called after message merge window closes
 */
export async function processIncomingMessage({ whatsappNumber, messages, db, anthropic, settings }) {
  const startTime = Date.now()

  try {
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

  // Extract media URL (first image message with a mediaUrl)
  const imageMediaUrl = messages.find(m => m.messageType === 'image' && m.mediaUrl)?.mediaUrl || null

  // Extract document media URL (for invoice/bill detection on documents sent as files)
  const documentMediaUrl = messages.find(m => m.messageType === 'document' && m.mediaUrl)?.mediaUrl || null

  // Extract quoted message text (buyer replying to a previous message)
  const quotedText = messages.find(m => m.quotedText)?.quotedText || null

  // --- Welcome eligibility (new buyer or 7+ days inactive) ---
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
  const lastMessageAge = previousLastMessageAt
    ? Date.now() - new Date(previousLastMessageAt).getTime()
    : Infinity
  const isFirstTime = !existingConversation
  const isWelcomeEligible = isFirstTime || lastMessageAge > SEVEN_DAYS_MS

  // --- Check: Is system active? ---
  if (!settings.isActive && !settings.partialAiEnabled) {
    // Both AI and partial AI are off → skip everything
    await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
      status: 'SKIPPED',
      deferReason: 'off_hours',
      processingMs: Date.now() - startTime,
      isMedia: hasMediaOnly,
    })
    return
  }

  // --- Partial AI mode: only 3-min follow-up for new/7+day buyers, nothing else ---
  if (!settings.isActive && settings.partialAiEnabled) {
    // Cooldown check — if Om responded, 10-min silence for ALL message types
    const freshCooldownPartial = await db.buyerConversation.findUnique({
      where: { whatsappNumber },
      select: { cooldownUntil: true },
    })
    if (freshCooldownPartial?.cooldownUntil && new Date() < new Date(freshCooldownPartial.cooldownUntil)) {
      await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
        status: 'COOLDOWN',
        deferReason: 'cooldown',
        processingMs: Date.now() - startTime,
      })
      console.log(`[Partial AI] ${whatsappNumber} — cooldown active (Om responded), skipping`)
      return
    }

    // Bill/order detection in Partial AI — same as Full AI
    // Match common bill/invoice document patterns (Bill, Invoice, Tax, Receipt, GST, etc.)
    const isBillDoc = mergedText?.match(/\[Document:.*(?:bill|invoice|tax|receipt|gst|challan|voucher|order).*\.pdf\]/i)
    if (isBillDoc) {
      const mediaReply = 'Ok noted sir, dispatching ASAP 🚚'
      await sendReplyViaWwbun(whatsappNumber, mediaReply)
      await createLog(db, conversation.id, mergedText, messageIds, {
        status: 'REPLIED',
        aiReply: mediaReply,
        deferReason: 'bill_document',
        processingMs: Date.now() - startTime,
        isMedia: true,
        sentViaWwbun: true,
      })
      console.log(`[Partial AI] ${whatsappNumber} — bill document detected, replied with dispatch confirmation`)
      return
    }

    // Invoice image detection (screenshot of purchase bill/tax invoice)
    // Also check documents sent as files (not just images)
    const invoiceMediaUrl = imageMediaUrl || documentMediaUrl
    if (invoiceMediaUrl && await isInvoiceImage(anthropic, invoiceMediaUrl)) {
      const mediaReply = 'Ok noted sir, dispatching ASAP 🚚'
      await sendReplyViaWwbun(whatsappNumber, mediaReply)
      await createLog(db, conversation.id, mergedText || '[invoice image]', messageIds, {
        status: 'REPLIED',
        aiReply: mediaReply,
        deferReason: 'bill_document',
        processingMs: Date.now() - startTime,
        isMedia: true,
        sentViaWwbun: true,
      })
      console.log(`[Partial AI] ${whatsappNumber} — invoice image detected, replied with dispatch confirmation`)
      return
    }

    const trimmedText = mergedText?.trim() || ''
    const isOrderId = /^\d{10,}$/.test(trimmedText)
    if (isOrderId) {
      scheduleDeferReply({
        whatsappNumber, deferMessage: settings.deferMessage, conversationId: conversation.id,
        mergedText, messageIds, logData: {
          status: 'DEFERRED', deferReason: 'order_id_detected',
          processingMs: Date.now() - startTime,
        }, db,
      })
      console.log(`[Partial AI] ${whatsappNumber} — order ID detected, scheduled defer to Ketu`)
      return
    }

    if (isWelcomeEligible) {
      // Skip the "Ask me if any question" nudge for media messages (images/documents)
      // Bill detection (regex + Vision) already ran above — if it was a bill, we already replied.
      // For non-bill media (product photos, samples, etc.), don't send the nudge —
      // the welcome message from wwbun is sufficient. The nudge is only for text messages.
      const hasMediaMessage = messages.some(m => ['image', 'document'].includes(m.messageType))
      if (hasMediaMessage) {
        await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
          status: 'SKIPPED',
          deferReason: 'welcome_media_no_nudge',
          processingMs: Date.now() - startTime,
          isMedia: true,
        })
        console.log(`[Partial AI] ${whatsappNumber} — new/returning buyer sent media, skipping nudge (welcome already sent)`)
        return
      }
      // Extra safety: check message logs for recent activity
      let skipFollowup = false
      if (!isFirstTime) {
        const recentLog = await db.messageLog.findFirst({
          where: {
            conversationId: conversation.id,
            createdAt: { gt: new Date(Date.now() - SEVEN_DAYS_MS) },
          },
          select: { id: true },
        })
        if (recentLog) skipFollowup = true
      }

      if (!skipFollowup) {
        console.log(`[Partial AI] ${whatsappNumber} — scheduling 3-min followup only (wwbun sent welcome)`)
        const followupTimer = setTimeout(async () => {
          pendingWelcomeFollowups.delete(whatsappNumber)
          try {
            // Re-check cooldown
            const freshConvo = await db.buyerConversation.findUnique({
              where: { whatsappNumber },
              select: { cooldownUntil: true },
            })
            if (freshConvo?.cooldownUntil && new Date() < new Date(freshConvo.cooldownUntil)) {
              console.log(`[Partial AI Followup] ${whatsappNumber} — skipped: Om intervened`)
              return
            }

            if (isGenericMessage(mergedText)) {
              // Short/generic message (hi, hello, etc.) → send nudge
              await sendReplyViaWwbun(whatsappNumber, WELCOME_FOLLOWUP_GENERIC)
              await createLog(db, conversation.id, mergedText, [], {
                status: 'REPLIED',
                aiReply: WELCOME_FOLLOWUP_GENERIC,
                deferReason: 'partial_ai_followup_generic',
                processingMs: 0,
                sentViaWwbun: true,
              })
              console.log(`[Partial AI Followup] ${whatsappNumber} — generic msg, sent nudge`)
            } else {
              // Real question (4+ words) — don't send "ask me any questions" nudge
              // It would be weird to say "ask me questions" when they already asked one
              console.log(`[Partial AI Followup] ${whatsappNumber} — real question, skipping nudge (AI off)`)
            }
          } catch (err) {
            console.error(`[Partial AI Followup Error] ${whatsappNumber}:`, err.message)
          }
        }, THREE_MINUTES_MS)

        pendingWelcomeFollowups.set(whatsappNumber, {
          timer: followupTimer,
          scheduledAt: Date.now(),
        })
      }
    }
    // Partial AI: don't process through normal pipeline
    await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
      status: 'SKIPPED',
      deferReason: 'partial_ai_only',
      processingMs: Date.now() - startTime,
      isMedia: hasMediaOnly,
    })
    return
  }

  // --- From here: isActive=true → full AI flow ---

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
  // Fresh DB read to catch cooldowns set by concurrent /api/intervention calls
  // (the `conversation` object from line 150 may have stale cooldownUntil due to race condition)
  const freshCooldown = await db.buyerConversation.findUnique({
    where: { whatsappNumber },
    select: { cooldownUntil: true },
  })
  if (freshCooldown?.cooldownUntil && new Date() < new Date(freshCooldown.cooldownUntil)) {
    await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
      status: 'COOLDOWN',
      deferReason: 'cooldown',
      processingMs: Date.now() - startTime,
    })
    return
  }

  // --- Check: Bill/invoice PDF (can have text caption) ---
  // Match common bill/invoice document patterns (Bill, Invoice, Tax, Receipt, GST, etc.)
  const isBillDocument = mergedText.match(/\[Document:.*(?:bill|invoice|tax|receipt|gst|challan|voucher|order).*\.pdf\]/i)
  if (isBillDocument) {
    const mediaReply = 'Ok noted sir, dispatching ASAP 🚚'
    await sendReplyViaWwbun(whatsappNumber, mediaReply)
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'REPLIED',
      aiReply: mediaReply,
      deferReason: 'bill_document',
      processingMs: Date.now() - startTime,
      isMedia: true,
      sentViaWwbun: true,
    })
    return
  }

  // --- Check: Invoice image (screenshot of purchase bill/tax invoice) ---
  // Also check documents sent as files (not just images)
  const invoiceMediaUrl = imageMediaUrl || documentMediaUrl
  if (invoiceMediaUrl && await isInvoiceImage(anthropic, invoiceMediaUrl)) {
    const mediaReply = 'Ok noted sir, dispatching ASAP 🚚'
    await sendReplyViaWwbun(whatsappNumber, mediaReply)
    await createLog(db, conversation.id, mergedText || '[invoice image]', messageIds, {
      status: 'REPLIED',
      aiReply: mediaReply,
      deferReason: 'bill_document',
      processingMs: Date.now() - startTime,
      isMedia: true,
      sentViaWwbun: true,
    })
    console.log(`[Full AI] ${whatsappNumber} — invoice image detected, replied with dispatch confirmation`)
    return
  }

  // --- Check: Media-only message (actual image/audio/video/document) ---
  if (hasMediaOnly) {
    await sendReplyViaWwbun(whatsappNumber, settings.mediaMessage)
    await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
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
        scheduleDeferReply({
          whatsappNumber, deferMessage: settings.deferMessage, conversationId: conversation.id,
          mergedText, messageIds, logData: {
            status: 'DEFERRED', deferReason: filter.name,
            processingMs: Date.now() - startTime,
          }, db,
        })
        console.log(`[${filter.displayName}] ${whatsappNumber} — scheduled defer to Ketu`)
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

  // --- 3-MIN FOLLOW-UP for new/7+day buyers (AI ON mode) ---
  // wwbun handles the welcome message. Digital-ketu2 only schedules the 3-min follow-up.
  let shouldFollowUp = isWelcomeEligible

  // Extra safety: check message logs too — if there are recent logs (within 7 days), skip
  if (shouldFollowUp && !isFirstTime) {
    const recentLog = await db.messageLog.findFirst({
      where: {
        conversationId: conversation.id,
        createdAt: { gt: new Date(Date.now() - SEVEN_DAYS_MS) },
      },
      select: { id: true },
    })
    if (recentLog) {
      shouldFollowUp = false
      console.log(`[Followup] ${whatsappNumber} — skipped: recent message log found despite old lastMessageAt`)
    }
  }

  // Skip the "Ask me if any question" nudge for media messages (images/documents)
  // Bill detection (regex + Vision) already ran above — if it was a bill, we already replied.
  // For non-bill media (product photos, samples, etc.), don't schedule the follow-up nudge —
  // let the code continue to normal AI processing so Claude can respond about the product.
  const hasMediaMessageFull = messages.some(m => ['image', 'document'].includes(m.messageType))
  if (shouldFollowUp && hasMediaMessageFull) {
    shouldFollowUp = false
    console.log(`[Followup] ${whatsappNumber} — new/returning buyer sent media, skipping nudge (continuing to AI)`)
  }

  if (shouldFollowUp) {
    console.log(`[Followup] ${whatsappNumber} — new/returning buyer, scheduling 3-min followup (wwbun sent welcome)`)

    // Schedule 3-minute delayed follow-up
    const followupTimer = setTimeout(async () => {
      pendingWelcomeFollowups.delete(whatsappNumber)
      try {
        // Re-check cooldown — if Om intervened, skip
        const freshConvo = await db.buyerConversation.findUnique({
          where: { whatsappNumber },
          select: { cooldownUntil: true },
        })
        if (freshConvo?.cooldownUntil && new Date() < new Date(freshConvo.cooldownUntil)) {
          console.log(`[Followup] ${whatsappNumber} — skipped: Om intervened (cooldown active)`)
          return
        }

        if (isGenericMessage(mergedText)) {
          // Generic message → send nudge
          await sendReplyViaWwbun(whatsappNumber, WELCOME_FOLLOWUP_GENERIC)
          await createLog(db, conversation.id, mergedText, [], {
            status: 'REPLIED',
            aiReply: WELCOME_FOLLOWUP_GENERIC,
            deferReason: 'welcome_followup_generic',
            processingMs: 0,
            sentViaWwbun: true,
          })
          console.log(`[Followup] ${whatsappNumber} — generic msg, sent nudge`)
        } else {
          // Real question → run AI
          const currentSettings = await db.settings.findUnique({ where: { id: 'default' } })
          if (!currentSettings?.isActive) {
            console.log(`[Followup] ${whatsappNumber} — AI is off, skipping AI followup`)
            return
          }
          console.log(`[Followup] ${whatsappNumber} — real question, running AI flow`)
          await runAiFlow({
            whatsappNumber,
            mergedText,
            quotedText,
            conversationId: conversation.id,
            normalizedText,
            db,
            anthropic,
            settings: currentSettings,
            startTime: Date.now(),
            messageIds: [],
          })
        }
      } catch (err) {
        console.error(`[Followup Error] ${whatsappNumber}:`, err.message)
      }
    }, THREE_MINUTES_MS)

    pendingWelcomeFollowups.set(whatsappNumber, {
      timer: followupTimer,
      scheduledAt: Date.now(),
    })

    // Log the welcome-eligible message and return — the follow-up handles the rest
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'SKIPPED',
      deferReason: 'welcome_followup_scheduled',
      processingMs: Date.now() - startTime,
    })
    return
  }

  // --- Check: Order ID / tracking number detection ---
  const trimmedText = mergedText.trim()
  const isOrderId = /^\d{10,}$/.test(trimmedText)
  if (isOrderId) {
    scheduleDeferReply({
      whatsappNumber, deferMessage: settings.deferMessage, conversationId: conversation.id,
      mergedText, messageIds, logData: {
        status: 'DEFERRED', deferReason: 'order_id_detected',
        processingMs: Date.now() - startTime,
      }, db,
    })
    console.log(`[OrderID] ${whatsappNumber} — detected order/tracking ID, scheduled defer to Ketu`)
    return
  }

  // --- Run AI flow (vector search → Claude → reply) ---
  await runAiFlow({ whatsappNumber, mergedText, quotedText, conversationId: conversation.id, normalizedText, db, anthropic, settings, startTime, messageIds })

  } finally {
    // If there's a pending defer with no active timer (paused by new message arrival),
    // and this processing didn't reschedule or cancel it, restart the timer
    restartDeferTimer(whatsappNumber)
  }
}

// ===========================================
// AI Flow: Vector Search → Claude → Reply
// Reusable by both main pipeline and welcome follow-up
// ===========================================
async function runAiFlow({ whatsappNumber, mergedText, quotedText, conversationId, normalizedText, db, anthropic, settings, startTime, messageIds }) {
  // --- VECTOR SEARCH: Single search across all 4 knowledge sources ---
  const allVectorResults = await vectorSearch(db, anthropic, mergedText, {
    limit: 10,  // fetch extra so corrections can be boosted into top 5
    minSimilarity: 0.0,
    excludeSources: ['STYLE_GUIDE', 'STYLE_PAIR', 'PREMIUM_PAIR'],
  })

  const bestSimilarity = allVectorResults.length > 0
    ? Math.max(...allVectorResults.map(r => Number(r.similarity)))
    : 0

  // Boost CORRECTION results to the top — corrections are Om's manual fixes and should always take priority
  const boostedResults = allVectorResults.map(r => ({
    ...r,
    similarity: r.source === 'CORRECTION' ? Math.min(Number(r.similarity) + 0.15, 1.0) : Number(r.similarity),
    boosted: r.source === 'CORRECTION',
  }))
  boostedResults.sort((a, b) => b.similarity - a.similarity)
  const knowledgeResults = boostedResults.slice(0, 5)
  // Personality DNA: find 3 similar real Om-buyer conversations to use as style examples
  const stylePairResults = await vectorSearch(db, anthropic, mergedText, {
    limit: 3,
    minSimilarity: 0.3,
    sources: ['STYLE_PAIR', 'PREMIUM_PAIR'],
  })

  console.log(`[Vector] ${whatsappNumber} — ${allVectorResults.length} results, best: ${(bestSimilarity * 100).toFixed(1)}%`)

  // --- Build prompt for Claude ---
  const recentLogs = await db.messageLog.findMany({
    where: {
      conversationId,
      status: { in: ['REPLIED', 'DEFERRED'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { buyerMessage: true, aiReply: true, status: true },
  })
  const conversationHistory = recentLogs.reverse()

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
    quotedText,
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
    await createLog(db, conversationId, mergedText, messageIds, {
      status: 'FAILED',
      deferReason: err.message,
      knowledgeChunks: allVectorResults.map(c => ({ title: c.title, source: c.source, similarity: Number(c.similarity).toFixed(3) })),
      processingMs: Date.now() - startTime,
    })
    return
  }

  // --- Check if Claude detected a conversation ender ---
  if (aiReply.includes('[SKIP]')) {
    await createLog(db, conversationId, mergedText, messageIds, {
      status: 'SKIPPED',
      deferReason: 'conversation_ended',
      promptTokens, completionTokens, totalTokens, costUsd,
      processingMs: Date.now() - startTime,
    })
    await db.settings.update({ where: { id: 'default' }, data: { dailySpentUsd: { increment: costUsd } } })
    if (normalizedText) await autoLearnAcknowledgment(db, normalizedText)
    console.log(`[Skip] ${whatsappNumber} — conversation ender detected by Claude`)
    return
  }

  // --- Check if Claude deferred ---
  if (aiReply.includes('[DEFER]')) {
    scheduleDeferReply({
      whatsappNumber, deferMessage: settings.deferMessage, conversationId,
      mergedText, messageIds, logData: {
        status: 'DEFERRED', deferReason: 'claude_deferred',
        promptTokens, completionTokens, totalTokens, costUsd,
        processingMs: Date.now() - startTime,
      }, db,
    })
    await db.settings.update({ where: { id: 'default' }, data: { dailySpentUsd: { increment: costUsd } } })
    return
  }

  // --- Send reply via wwbun ---
  // Cancel any pending defer — AI is engaging with the buyer
  cancelPendingDefer(whatsappNumber)
  const sendResult = await sendReplyViaWwbun(whatsappNumber, aiReply)

  // --- Update daily spend ---
  await db.settings.update({ where: { id: 'default' }, data: { dailySpentUsd: { increment: costUsd } } })

  // --- Log ---
  const catalogMatches = knowledgeResults.filter(c => c.source === 'CATALOG')
  await createLog(db, conversationId, mergedText, messageIds, {
    status: 'REPLIED',
    aiReply,
    knowledgeChunks: allVectorResults.map(c => ({ title: c.title, source: c.source, similarity: Number(c.similarity).toFixed(3) })),
    similarityScore: bestSimilarity,
    catalogMatch: catalogMatches.length > 0 ? catalogMatches[0].metadata : null,
    promptTokens, completionTokens, totalTokens, costUsd,
    promptSent: { system: systemPrompt, user: userPrompt },
    sentViaWwbun: !!sendResult,
    wwbunMessageId: sendResult?.messageId || null,
    processingMs: Date.now() - startTime,
  })

  console.log(`[Reply] ${whatsappNumber} — ${totalTokens} tokens, $${costUsd.toFixed(6)}, ${Date.now() - startTime}ms`)
}

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

  // Personality DNA: inject similar real Om-buyer conversations as tone examples
  if (stylePairs && stylePairs.length > 0) {
    prompt += `\n\nSIMILAR PAST CONVERSATIONS (reply like Om — match his tone, length, and style):\n`
    for (const pair of stylePairs) {
      const meta = typeof pair.metadata === 'string' ? JSON.parse(pair.metadata) : pair.metadata
      if (meta?.buyerMessage && meta?.omReply) {
        prompt += `Buyer: ${meta.buyerMessage}\nOm: ${meta.omReply}\n\n`
      }
    }
  }

  return prompt
}

function buildUserPrompt({ mergedText, knowledgeResults, stylePairResults, conversationHistory, quotedText }) {
  let prompt = ''

  // Knowledge results from vector search (top 5 matches from catalog + templates + policies)
  if (knowledgeResults.length > 0) {
    const hasCorrection = knowledgeResults.some(r => r.source === 'CORRECTION')
    prompt += `KNOWLEDGE BASE (top matches for this question — use this info to answer):\n`
    if (hasCorrection) prompt += `⚠️ CORRECTION entries below are Om's manual fixes to previous AI mistakes. ALWAYS follow corrections over other sources.\n`
    for (const result of knowledgeResults) {
      const sim = (Number(result.similarity) * 100).toFixed(0)
      const prefix = result.source === 'CORRECTION' ? '⚠️ ' : ''
      prompt += `---\n${prefix}[${result.source}] ${result.title || ''} (${sim}% match)\n${result.content}\n`
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
      if (msg.status === 'DEFERRED') {
        prompt += `Buyer: ${msg.buyerMessage}\n[DEFERRED TO KETU — Ketu is handling this]\n\n`
      } else {
        prompt += `Buyer: ${msg.buyerMessage}\nAssistant: ${msg.aiReply}\n\n`
      }
    }
  }

  // Quoted context (buyer replied to a previous message)
  if (quotedText) {
    prompt += `BUYER IS REPLYING TO THIS PREVIOUS MESSAGE:\n"${quotedText}"\n\n`
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
