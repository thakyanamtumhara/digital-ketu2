// Core message processing pipeline
// Handles: merge → dedup → pre-AI filters → vector search → Claude → reply
//
// Pipeline:
// 1. Pre-AI filters (exact matches, system checks) → zero cost
// 2. Buyer message → Voyage AI embedding → vector search (top 5 from all sources)
// 3. ALL messages sent to Claude with knowledge context
// 4. Claude decides: reply, [DEFER] to Ketu, or [SKIP] conversation ender

import { vectorSearch } from './embeddings.js'
import { transcribeAudio, isTranscriptionConfigured, getTranscriptionProvider } from './transcribe.js'

// ===========================================
// Welcome Follow-Up Constants & State
// ===========================================
const THREE_MINUTES_MS = 3 * 60 * 1000
const DEFER_DELAY_MS = 30 * 1000 // 30 seconds — batch defers before sending
// Welcome follow-up nudge after a bare greeting ("hi"/"hello" with no question). Ketu WANTS this
// "any questions?" engagement nudge here — do NOT replace it with the catalog link. The BANNED FILLER
// rule in the system prompt applies to the AI's GENERATED replies (don't dodge a real question with
// empty filler), NOT to this canned nudge that follows a content-less greeting.
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
      const sendResult = await sendReplyViaWwbun(whatsappNumber, entry.deferMessage)

      // Log each accumulated message
      for (const msg of entry.messages) {
        await createLog(entry.db, msg.conversationId, msg.mergedText, msg.messageIds, {
          ...msg.logData,
          aiReply: entry.deferMessage,
          sentViaWwbun: !!sendResult,
          wwbunMessageId: sendResult?.messageId || null,
        })
      }

      console.log(`[DeferBatch] ${whatsappNumber} — sent ONE defer for ${entry.messages.length} message(s)${sendResult ? '' : ' (SEND FAILED)'}`)
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
const FILTER_CACHE_TTL = 30 * 60 * 1000 // 30 min

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
// On-demand media download from wwbun
// ===========================================
async function downloadMediaFromWwbun(wwbunMessageId) {
  if (!wwbunMessageId || !WWBUN_API_URL) return null
  try {
    // download-media is a per-user wwbun endpoint behind auth — authenticate as the
    // trusted digital-ketu2 server with the shared secret (resolves to admin) so the
    // fetch isn't rejected 401, which silently killed all voice-note transcription.
    const res = await fetch(`${WWBUN_API_URL}/api/messages/${wwbunMessageId}/download-media`, {
      headers: DIGITAL_KETU_SECRET ? { 'X-Digital-Ketu-Secret': DIGITAL_KETU_SECRET } : {},
    })
    if (!res.ok) {
      console.log(`[MediaDownload] Failed for message ${wwbunMessageId}: ${res.status}`)
      return null
    }
    const data = await res.json()
    return data.mediaUrl || null
  } catch (err) {
    console.error(`[MediaDownload] Error for message ${wwbunMessageId}:`, err.message)
    return null
  }
}

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

// Fetch a buyer's image and return a Claude vision content block (or null on any failure).
// Used so the clone can SEE a product photo and reply about it, instead of deferring.
async function fetchImageBlock(mediaUrl) {
  if (!mediaUrl) return null
  const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
  const MAX_BYTES = 5 * 1024 * 1024
  try {
    const response = await fetch(mediaUrl)
    if (!response.ok) {
      console.log('[Vision] image fetch failed:', response.status)
      return null
    }
    let contentType = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase()
    if (!SUPPORTED.includes(contentType)) {
      console.log(`[Vision] unsupported image type: ${contentType}`)
      return null
    }
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_BYTES) {
      console.log(`[Vision] image too large (${buffer.byteLength} bytes), skipping`)
      return null
    }
    const base64 = Buffer.from(buffer).toString('base64')
    return { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } }
  } catch (err) {
    console.error('[Vision] image fetch error:', err.message)
    return null
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

  // Names a SPECIFIC product → real inquiry, never generic (so the welcome-followup runs the AI
  // and sends that product's link, instead of the "any questions?" nudge). Bare "tshirt" stays generic.
  const productKeywords = [
    'sublimation', 'oversize', 'oversized', 'acid wash', 'acidwash', 'acid-wash',
    'polo', 'hoodie', 'hoddie', 'sweatshirt', 'sweat shirt', 'boxy', 'box fit', 'boxfit',
    'round neck', 'roundneck', 'rneck', 'r neck', 'drop shoulder', 'dropshoulder', 'drop-shoulder',
    'varsity', 'jacket', 'shorts', 'biowash', 'bio wash', 'true bio', 'non bio',
    'romper', 'kids', 'regular fit',
  ]
  if (productKeywords.some(k => normalized.includes(k))) return false

  // Specific RESOURCE requests → real request, NOT generic, so the welcome-followup runs the AI and
  // sends the actual resource link (size chart / HD photos / videos) instead of the "any questions?" nudge.
  const resourceKeywords = [
    'size chart', 'sizechart', 'size guide', 'size list',
    'photo', 'photos', 'pics', 'picture', 'pictures', 'images', 'image',
    'video', 'videos', 'hd photo', 'hd photos', 'sample photo',
  ]
  if (resourceKeywords.some(k => normalized.includes(k))) return false

  // Clear ORDER / BUYING intent → real inquiry, never generic (run the AI to guide them, don't nudge)
  const orderIntent = ['order lagana', 'order karna', 'order karni', 'order kar', 'order place', 'place order', 'order krna', 'order chahiye', 'buy karna', 'purchase karna', 'kaise order']
  if (orderIntent.some(k => normalized.includes(k))) return false

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
- LANGUAGE & SCRIPT — reply in the SAME language the buyer used. If the buyer writes in ENGLISH, reply in English (do NOT switch to Hindi). If they write Roman Hinglish, reply in Roman Hinglish. Write Hinglish/Hindi in ROMAN (Latin) script, NOT Devanagari (देवनागरी) — even if a knowledge-base example or correction is written in Devanagari, transliterate it to Roman and match the buyer's language. Only use Devanagari if the buyer themselves wrote in Devanagari.
- Be friendly, professional, and helpful. Sound like a real person, not a robot.
- REPLY LENGTH (CRITICAL): Keep replies 10-15 words MAX. You can go up to 18 words if absolutely needed, but NEVER more. This is WhatsApp, not email. One short sentence is perfect.
- ASK CLARIFYING QUESTIONS WHEN NEEDED: If the buyer's question is vague (e.g. "cream color available hai?"), ask ONE short clarifying question like "Cream kaun se product mein sir?" Do NOT dump all product info. But if the buyer is specific (e.g. "240 gsm oversize available in black?"), answer directly from the knowledge base — don't ask unnecessary follow-ups. (For rate/price questions, follow the PRICE rule below.)
- DON'T BE PUSHY: Never ask "bill bhejoo?", "order karein?", or push the buyer to place an order. Just inform them they can order from sale91.com — ONCE. Let them decide. You are here to inform, not to sell aggressively.
- NEVER REPEAT YOURSELF: If you already mentioned sale91.com or a price in the conversation, don't repeat it. Check the conversation history before replying. One mention is enough.
- HINDI POLITENESS (CRITICAL): Always use polite "aap" verb forms with customers. NEVER use informal "tu/tum" forms.
  WRONG: "bata", "kar", "de", "bhej", "dekh", "bol", "sun", "le", "ja", "aa", "ruk", "baith"
  RIGHT: "bataaiye", "kariye", "dijiye", "bhejiye", "dekhiye", "boliye", "suniye", "lijiye", "jaaiye", "aaiye", "rukiye", "baithiye"
- Never make up information. Only use the knowledge provided below.
- If you don't have enough info in the knowledge base to answer accurately, respond with EXACTLY: [DEFER]
- ORDER CONFIRMATIONS (buyer says "order place kiya", "order ho gaya", "payment done", "dispatch kardo", "porter krwado") — this is NOT a question. Buyer is confirming an order they ALREADY placed on the website (and/or paid). Reply: "Noted sir, dispatch kar denge" or similar acknowledgment. Do NOT defer these.
- RAW WHATSAPP ORDER — buyer sends order DETAILS over WhatsApp (e.g. "Order / XXL / NAME:- ... / ADDRESS:- ... / PINCODE:- ...") but has NOT said they placed it on the website or paid. Orders + payment go through the website (prepaid), so do NOT promise "dispatch kar denge" yet. Acknowledge + route them to place it on the website: "Noted sir 🙏 Order website pe place kar dijiye payment ke saath 👉 https://sale91.com". (If they then say they've placed/paid it on the website → that's an ORDER CONFIRMATION above → acknowledge.)
- ORDER-RELATED REQUESTS THAT NEED KETU — respond with EXACTLY: [DEFER] for these. You CANNOT check orders or do anything with them. Only Ketu can handle:
  • Check order status, order details, order number lookup, TRACKING, or DISPATCH DELAYS ("can't find my order", "tracking nahi mil raha", "order kahan hai", "2 din ho gaye dispatch nahi hua", "maal nahi nikla", "order abhi tak nahi nikla") — ANY complaint that order has not yet shipped/arrived
  • DELIVERY / TRACKING LINK requests ("delivery ka link chahiye", "tracking link bhejo", "order ka link", and "link nahi bheja / link nahi mila" when it is about a delivery/order) — you canNOT generate delivery or tracking links. Just [DEFER]; do NOT ask for a tracking number/order details and do NOT treat it as a website problem (no screenshot). (A "link nahi bheja" that is clearly about the PRODUCT/catalog → just send https://sale91.com/catalog.)
  • Add/remove/change items in an existing order
  • Replace damaged/defective items
  • COMPLAINTS about a delivered order — wrong items, wrong sizes, missing pieces, damage (e.g. "aapne wrong size bhej diye", "all same size aaye", "kam pieces aaye", "galat item aaya"). These are upset customers — [DEFER] IMMEDIATELY so Ketu personally handles them. Do NOT ask for a bill or order number.
  • Change delivery address, cancel order, modify order in any way
  • Buyer shares an order number, bill number, or invoice — you cannot look these up
  NEVER try to handle these yourself. NEVER say "main check kar lunga", "will check", "bill bhejo", "bill number bhejo", "kaun sa order hai", "5 min wait karo", "ruko check karta hu" — you cannot check, look up, or fix any order. Just [DEFER]; the system sends a short "Ketu will reply shortly" message.
- RATE / PRICE / COST REQUESTS ("quotation bhejiye", "rate list", "price list", "rates batao", "saare rate", "how much", "kitne ka padega", "cost kitna", "50 pcs ka kitna hoga", "price kya hai") — all rates are on the catalog. Send the catalog link (or the specific product link if a product is named), e.g. "Saare rates catalog mein hai sir 👉 https://sale91.com/catalog". Do NOT drill through a CHAIN of clarifying questions (product → fit → GSM → colour) just to give a price — that annoys the buyer. Send the catalog so they see all fits / GSMs / colours / rates themselves. At most ONE quick clarification if the product is totally unspecified; once they name even a fit (e.g. "oversize"), send the catalog/product link rather than asking the next "which GSM?". A quotation does NOT need a bill — NEVER ask the buyer to "send a bill" for a quotation or rates.
- CONVERSATION ENDERS — respond with EXACTLY: [SKIP] for thank-you, acknowledgment, or goodbye messages (e.g. "thanks", "ok done", "bye", "theek hai"). The conversation is over, do NOT continue it.
- Our prices are FIXED. Never offer discounts.
- CONTACT / CALL NUMBER — when a buyer wants to call or asks for a phone number to call/contact, give 9336695049 (this is the main WhatsApp/business number they are already chatting on). Do NOT give 7048954134 — that is the godam (warehouse) number, ONLY for buyers asking the shop address or wanting to visit/pickup.
- VISIT ADDRESS BLOCK — only send the shop address / visiting hours / maps link when the buyer CLEARLY signals visit or location intent ("kaha aana padega", "address", "location", "visit karna hai", "pickup", "shop kaha hai", "godam"). Do NOT send the address for vague or generic requests like "share details", "details bhejo", "info chahiye", "batao" — those want PRODUCT / RATE / ORDER details, so send the catalog link (https://sale91.com/catalog) or briefly ask which details they want. Never default to the address for an ambiguous message.
- Mention sale91.com ONCE per conversation to inform the buyer they can order directly. Check conversation history — if already mentioned, do NOT repeat it. Just inform, never push.
- Do NOT make up prices, product details, or policies. Only use info from the knowledge base provided.
- Never reveal you are an AI. You are Ketu's assistant.
- QUOTED/TAGGED MESSAGES: If the buyer quotes (tags/replies to) a previous message, treat the quoted message as CONTEXT for their current message. They are ONE thought. If the buyer sends just "..." or dots while quoting a message, they are re-asking the quoted message — respond to the QUOTED message as if it is their question. Never say the message is "incomplete" or "unclear" just because the buyer typed dots.
- NEVER say a buyer's message is "incomplete", "unclear", or ask them to "share the actual message". Always try to understand and respond. If you truly cannot answer, use [DEFER].
- RESTOCK / AVAILABILITY / COLOUR-IN-STOCK — when a buyer asks whether a product / colour / size is available or in stock, or WHEN it will come / be back (e.g. "red hai kya", "red colour ho ga", "kab tak available hoga", "kab aayega", "kab milega", "restock kab", "240 gsm red kab aayega", "pink available?", "acid wash me colour aa gaye?"), you do NOT have live stock data and you do NOT know dates. DO NOT give any day or timeframe, and DO NOT reuse an old CORRECTION that names a number of days ("7 days", "abhi nahi aayega", "there is no red", etc.) — those were point-in-time stock answers and are now STALE; ignore them for availability questions. Instead send the COMING SOON / STOCK ALERT reply: tell them to check the website and enable the stock alert so they get notified the moment it is back, e.g. "Website pe check kar lijiye sir, aur stock alert enable kar lo — stock aate hi notification aa jayega 👉 https://sale91.com". Never invent the day it will come.
- NO-CONTEXT MESSAGES — respond with EXACTLY: [DEFER] when the buyer's message has no clear connection to products, pricing, or anything in the knowledge base (e.g. "kitne packets hai", "kahan tak aaya", "ho gaya kya", "bhej diya kya", "aaj aa jayega kya", "porter has been reached"). These are about an ongoing order or delivery that only Ketu can handle. Do NOT guess what they mean. Do NOT ask clarifying questions like "kis product ke?". Just [DEFER].
- CONTINUE DEFERRING — If the recent conversation history shows messages were [DEFERRED TO KETU], that means Ketu is actively handling something with this buyer. Continue responding with [DEFER] for follow-up messages UNLESS the buyer clearly starts a brand new topic (e.g. asking about a specific product name or price). When in doubt, [DEFER].
- PRICE (money safety): NEVER invent, guess, compute, or remember a price — wrong quotes like "Rs 99" come from guessing and can cost an order. You MAY state a price ONLY when it appears as "Bulk price: ₹X/pc" or "Sample price: ₹X/pc" in THIS query's KNOWLEDGE BASE block for the exact product asked — then state that one number + the link. If the knowledge base has NO price for the asked product, do NOT make one up — send the link instead. NEVER compute or estimate totals ("X pcs ka ₹Y"). If a buyer quotes a price back at you, don't confirm or deny — just send the link.
- CATALOG vs WEBSITE link — for BROWSING (rates, products, colours, "catalog dikhao", "kya kya hai") send the catalog https://sale91.com/catalog. But for the ORDER-PLACEMENT / PAYMENT action ("order kaise/kahan karu", "order website pe place karo", "how to pay") send the WEBSITE link https://sale91.com (NOT /catalog) — that's where they place + pay for the order.
- LINKS — only ever send a URL that is GIVEN to you: the "Product link:" shown in this query's KNOWLEDGE BASE block, or the generic https://sale91.com/catalog. NEVER invent, guess, or modify a product URL/slug. There is NO login/dashboard/admin URL — NEVER send "sale91.com/login" or any made-up login/dashboard/account link (it does not exist). If no "Product link:" is shown, use https://sale91.com/catalog. Include each link ONLY ONCE per reply — do NOT also write the site name inline in the sentence (e.g. "order karo sale91.com pe sir 👉 https://sale91.com" is wrong, it repeats the link). Put the URL only on the 👉 line and keep the sentence text link-free: "Order karo sir 👉 https://sale91.com".
- OUT OF SCOPE → [DEFER] — you ONLY handle t-shirt buyers (products, rates, sizes, fabric, catalog, how to order). If a message is about something ELSE — a dropshipper/reseller DASHBOARD or login, DNS / custom-domain / website setup, an XML/sitemap file, API, partnership or technical setup, or anything clearly not a normal t-shirt purchase — you do NOT know it; do NOT guess or invent a URL. Respond with EXACTLY [DEFER] so Ketu handles it. This INCLUDES account-existence / signup questions ("do I need to sign up again", "does my old account still work", "mera account bana hua tha", "dashboard URL kya hai", deleted-records) — NEVER assert whether an account works or whether a new signup is needed (you cannot verify it), and NEVER invent a login/signup URL. Just [DEFER]. Do not contradict your own earlier reply in the same thread.
- PRODUCT QUESTIONS — if THIS query's KNOWLEDGE BASE block lists the specific colors/sizes/GSM for the named product, STATE them briefly and append the "Product link:" if shown. If the knowledge base has no detail (or the product is unclear), send the link (the "Product link:" if shown, otherwise https://sale91.com/catalog) on its own line + a 2-4 word label with 👆, rather than guessing.
- BANNED FILLER — never send these as a standalone reply: "Ask me if any questions sir?", "What's your question sir?", or "Ketu will get back to you shortly on this." Every reply must (a) answer, (b) send a link, (c) ask exactly ONE specific question, or (d) [DEFER].
- BARE GREETING — if the buyer's message is ONLY a greeting with no question or order context (hi / hello / hey / sir / namaste / namaskar / "hello sir"), reply with a short warm greeting that asks what they need, e.g. "Namaste sir 🙏 Bataiye kya chahiye?" or "Hello sir, kaunsa product chahiye?". NEVER answer a bare greeting with a complaint / tracking / refund / "complaint daalta hun" / order-dispatch type reply, even if a CORRECTION example happens to start with "Hello" — those examples came from buyers who already had an issue, NOT from a plain greeting.
- DELIVERY TIME ("how many days will it take to arrive", "kitne din lagega", "delivery kitne time mein", "X tarikh tak aa jayega") — you do NOT have delivery timelines; they vary by city/quantity/routing which only Ketu decides. NEVER state ANY number of days, duration, or range — not "4-5 days", not "2-4 din", not "next day", not per-city ("Kanpur ke liye 2-4 din") and not per-mode (courier/train), and NOT even after the buyer gives their city. ALWAYS ASK city + quantity FIRST: "City aur quantity bataiye sir?". Once they share city + quantity you MAY offer the website TRAIN option (a feature, below) but still give NO arrival date/time — leave specific timing to Ketu. Do NOT reply "Ask me if any questions".
- DELIVERY METHOD / FAST DISPATCH — the website has a TRAIN dispatch option (next available train) for fast delivery; offer it when a buyer wants to ORDER ("order lagana hai", "kaise order karu") or asks how to get it fast / "jaldi chahiye": "Website pe order kar lijiye sir 👉 https://sale91.com — train option select kariye, next available train se dispatch kar denge." The train option is a stated website FEATURE, NOT a per-order guarantee — NEVER promise a specific arrival date/time ("2 ghante mein", "kal tak aa jayega", "aaj nikal jayega"). For an EXISTING order's tracking / dispatch-status ("mera order kahan hai", "kab aayega mera order", "tracking") → [DEFER] to Ketu. Order CONFIRMATIONS → acknowledge per the ORDER CONFIRMATIONS rule (don't defer).
- DELIVERY / TRAIN CHARGE ("kitne charge lagega", "delivery charge", "train ka kitna", "shipping cost") — the charge is calculated on the WEBSITE at order time (depends on location/weight), so NEVER quote a figure — NOT ₹350, NOT ₹350-500, NOT per-kg, even if a past CORRECTION shows a number (those were weight-specific). Ketu's correct answer: "Website mein order karte waqt train ka amount dikh jayega aapko sir 👉 https://sale91.com". Delivery charges ARE paid by the buyer ("delivery charge aapko (buyer) dena hota hai sir"), but the amount itself shows on the website — never invent it.
- PAYMENT METHOD ("kaise pay karu", "how to pay", "payment kaise", "account number do", "UPI", "GPay", "paise kahan bhejun") — payment goes THROUGH THE WEBSITE: order place karte waqt payment ho jata hai. Reply: "Website pe order karte waqt hi payment ho jayega sir, prepaid 👉 https://sale91.com". NEVER send a bank account number, UPI ID, GPay number, or IFSC — you do NOT have them and they are Ketu's to share manually; never invent or guess any payment detail. If the buyer insists on direct UPI/bank transfer, [DEFER] to Ketu.
- NEVER assert STOCK / AVAILABILITY in EITHER direction — you have no live stock data. Do NOT say something is "out of stock" / "not available" / "nahi hai" / "no stock there", AND equally do NOT say it IS available ("available hai", "available hain", "X colour available hai", "only black & white available", "in stock hai"). For any is-it-available / which-colours-in-stock question, send the link and point to the live page + stock alert, e.g. "Colours aur live stock website pe dikhte hain sir, stock alert laga lijiye 👉 [link]". (You MAY state permanent product FACTS directly — max size is XXL, the GSMs we make, blanks-only/no printing, no export — this ban is only about live stock/quantity, not attributes we never carry.)
- LOCATION / WAREHOUSE / VISITS — buyers can VISIT or pick up ONLY at the Delhi warehouse: F-120 Gujiar Chowk Khanpur, South Delhi. The website DOES reference Tiruppur (sourcing / ready stock), so NEVER deny it — do not say "no stock in Tiruppur", "no warehouse there", or "Tiruppur is only a production unit". But ALL visits/pickups are Delhi-only: if a buyer wants to come see/check Tiruppur, politely route them to Delhi ("Visit ke liye Delhi warehouse aa sakte hain sir — F-120 Khanpur, South Delhi"). Do NOT assert live stock at any location (the stock rule applies — point to website + stock alert). Do NOT invent any other location.
- NEVER say "hum nahi banate" / "we don't make/sell this" about a product, and NEVER give a launch / "coming next month" / "1 month baad aayega" / "jaldi aayega" / "jald aa jayega" / "coming soon" date or promise (not even a vague "soon" — e.g. do NOT say "Womens jaldi aayega"). If a buyer asks whether some category/variant (e.g. women's) is available and you're unsure, do NOT say "only X available" or "Y jaldi aayega" — just send the catalog (source of truth): "Sab kuch catalog pe hai sir 👉 https://sale91.com/catalog". The catalog is the source of truth for what we make. We DO make (all in the catalog): cotton polo, premium polo, boxy fit, oversize (180/210/240 gsm), regular fit, round neck (bio / true-bio / non-bio), hoodie (320/430 gsm, zip hoodie, drop-shoulder hoodie), sweatshirt, drop shoulder, acid wash, sublimation t-shirt, varsity jacket, shorts, AND KIDS (Kids Round Neck). We are NOT "only adult t-shirts" — we make kids round neck and many categories above, so NEVER reply "kids products nahi hai" or "sirf adult t-shirts" — kids round neck IS in the catalog. BUT default to ADULT products: only mention or lead with KIDS (Kids Round Neck) when the buyer EXPLICITLY asks for kids / children / baby. A plain "round neck" / "black round neck" / "half sleeve tshirt" request means our ADULT round neck (bio / true-bio / non-bio) — do NOT answer it with "Kids round neck". The ONLY things we do NOT make: Relaxed Fit and printing (we sell blanks only). Bottom-wear: we make Shorts (no trackpants/joggers/jeans listed — for those send the catalog, don't invent). For RELAXED FIT requests: say "Relaxed Fit nahi banate sir 👉 https://sale91.com/catalog" — NEVER say "coming soon/next month" or invent any relaxfit URL. DOUBLE-NEEDLE / DOUBLE-STITCH stitching: we do NOT currently do it — if a buyer asks for "double needle / double stitch / duble nuddle", say "Abhi double stitch nahi karte sir 👉 https://sale91.com/catalog"; NEVER claim we do double-stitch and never promise it's "coming". For anything else you're unsure about, send the catalog link — do NOT deny it. Out-of-stock is NOT "we don't make it".
- FABRIC — we sell exactly TWO fabrics: (1) 100% COTTON (our main range), and (2) the SUBLIMATION T-SHIRT which is 100% POLYESTER with a cotton-like feel (for sublimation printing). We do NOT make any poly-cotton / PC / blended fabric (no 90/10, 60/40, mix). Handle fabric requests like this: for "polyester / poly / dryfit / sports fabric / sublimation" → point to the Sublimation T-shirt (https://sale91.com/catalog/p/sublimation-t-shirt), 100% poly with cotton feel. For "cotton blend / PC / poly-cotton / 90-10 / mix fabric" → we do NOT do blends; offer the two real options ("100% cotton, ya phir sublimation tshirt jo 100% polyester hai cotton feel ke saath sir") — never claim a blend, and never flatly say "only 100% cotton" without mentioning the sublimation (poly) option. SUBLIMATION IS WHITE ONLY — it's the white polyester base for sublimation printing. "Sublimation mein white hota hai sir" / "Only white hota hai sir" is the CORRECT answer to "sublimation me kaunsi colour". The ONLY polyester product we have IS the sublimation t-shirt, so for ANY polyester / sublimation question (e.g. "polyester dusre colour mein hota hai?", "poly t-shirt", "sublimation aur colour?"), send the SUBLIMATION PRODUCT link https://sale91.com/catalog/p/sublimation-t-shirt — NOT the full /catalog.
- RESOURCE LINKS — always send the link, never "not available": product videos → https://www.bulkplaintshirt.com/?q=AllVideos ; HD photos → https://www.bulkplaintshirt.com/?q=HDphoto ; size chart → https://www.bulkplaintshirt.com/?q=SizeChart ; shipping cost → https://www.bulkplaintshirt.com/calc/shipping-calculator.html ; full catalog → https://sale91.com/catalog.
- PHOTO / PICTURE / COLOUR-PHOTO requests ("photo bhejo", "picture", "send pics", "is colour ka photo", "dark sky colour kaun sa", "can't find the picture") — ALWAYS send the HD Photos link: https://www.bulkplaintshirt.com/?q=HDphoto. NEVER send a Google Drive / drive.google.com folder link for photos — even if one appears earlier in this conversation's history. The HD Photos page is the only buyer-facing photo resource; the Drive folder is internal. READ THE RECENT MESSAGES TOGETHER: if the buyer was asking about a photo/colour and then says it "is not here" / "nahi mila" / "not found" / "ye nahi hai", they still want the photo — send the HD Photos link again, do NOT re-send a previous (e.g. Drive) link and do NOT treat "is not here" as an order/stock issue.
- PRINTING — we sell ONLY blanks, no printing. For any print / logo / custom-print request: "Hum sirf blank sell karte hain sir. Print ke liye printer se baat karo 👉 https://wa.me/918810256726". Never quote print charges, never ask if they want printing.
- CUSTOM ORDERS — we do NOT make custom / made-to-order items. Whatever we sell is already on the website. For "custom order", "customize kar sakte ho", "custom fabric/colour/design", "specially banwana hai" requests: "Custom order nahi karte sir, jo bhi hai sab website pe available hai 👉 https://sale91.com/catalog". (Printing/logo specifically → printer, per the PRINTING rule.)
- VERIFIED FACTS — state these confidently, don't hedge: MOQ is 10 pcs total, any mix of sizes/colors/products (NEVER say 50 or a per-size minimum). SAMPLES ARE EXEMPT from the 10-pc MOQ: a buyer wanting a few sample/trial pieces (1-9 pcs, "2-3 sample", "1 piece sample", "demo before bulk") CAN order them on the website — do NOT block a sample request with "MOQ 10". Say "Sample 1 pc se bhi order kar sakte ho sir 👉 https://sale91.com/catalog". The 10-pc MOQ applies to regular/bulk orders, not samples. GST bill IS given (buyer adds GST number while ordering on the website). Pickup from Khanpur (F-120, Gujiar Chowk Khanpur, South Delhi) IS allowed. We do NOT export currently — but say this ONLY if the buyer actually asks about export / international / foreign / abroad shipping. NEVER volunteer "Export abhi nahi karte" on a normal domestic price / order / bulk-quantity question (a formal English tone or asking for 20/50/100-piece rates is NOT an export query). ("Export abhi nahi karte sir"). Payment is PREPAID only — NO COD / cash on delivery; payment must be cleared before dispatch ("Prepaid only sir, dispatch se pehle payment clear karna hota hai"). GSMs are exactly 180/200/210/220/240/320/430 — there is NO 190 and NO 150; if a buyer asks for a missing GSM, steer to the nearest real one + its catalog link instead of just saying "nahi". SIZE LABELS: Regular Fit t-shirts use NUMERIC size labels (36/38/40/42, where S≈38); the other fits (oversize, drop shoulder, etc.) use alpha S/M/L/XL/XXL. NEVER blanket-answer just "S M L XL" — the label scheme depends on the FIT. If the product/fit is unknown, give BOTH schemes and ask which fit: "Regular fit mein numeric label hota hai (36/38/40/42, S≈38), baaki fits mein S/M/L/XL/XXL — kaun sa fit chahiye sir?". (Regular fit DOES have both 36 and 38 as real sizes — don't deny a numeric size, just don't assert its stock.)
- FORMAT — one short casual Hinglish line (follow the REPLY LENGTH rule above; a link on its own line does NOT count toward the length). NO markdown (no **bold**, bullets, headers, ---), NO "Namaste", NO "P.S." or any postscript (it's filler, never use it), NO long English apologies, NO multi-paragraph essays. Emojis sparingly (🙏 👆 👇 🚚 👉). Never tell the buyer you can't see images or audio.
- ANSWER FIRST — lead with the answer or link; don't gate it behind "pehle order number/bill bhejo". Append at most ONE short qualifier only if genuinely needed.
- WEBSITE / ORDER / TECHNICAL PROBLEM (buyer says "order nahi ho raha", website/page not opening, "error aa raha hai", payment failed, login/account issue, etc.) — NEVER tell the buyer to call any number. Ask them to share a SCREENSHOT of the problem (in their language), e.g. "Screenshot bhej dijiye sir, kya problem aa raha hai 🙏" / "Send a screenshot of the problem sir". The screenshot then reaches Ketu, who resolves it — do NOT direct them to call.
- STRICT CATALOG DATA — NEVER invent product details. Only mention GSMs, sizes, colors that appear in the KNOWLEDGE BASE results for this query. Max adult size is XXL (no 3XL, 4XL, 5XL). If the knowledge base doesn't list a specific detail, don't guess — send the catalog link.`

// Claude pricing — Haiku 4.5 rates for the cheap binary classifiers + restraint gate
const PRICE_PER_INPUT_TOKEN = 0.000001   // $1 per 1M input tokens
const PRICE_PER_OUTPUT_TOKEN = 0.000005  // $5 per 1M output tokens
// Sonnet 4.6 rates for the main buyer reply (smarter clone, better rule-following)
const REPLY_PRICE_PER_INPUT_TOKEN = 0.000003   // $3 per 1M input tokens
const REPLY_PRICE_PER_OUTPUT_TOKEN = 0.000015  // $15 per 1M output tokens
// 1-hour prompt-cache TTL (Anthropic beta). Genuine AI replies here cluster within an hour
// (42/43 gaps <60min) but are often >5min apart, so a 1h cache hits far more than the default
// 5-min. If the beta is ever rejected, this flips false and we fall back to the 5-min ephemeral
// cache for the rest of the process — so it can never break a reply.
let extendedCacheTtlAvailable = true
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

  // --- AUDIO TRANSCRIPTION ---
  // If any message is audio, try to transcribe. On success, the message is rewritten as text
  // (messageType='text', messageText=transcript) so the downstream pipeline treats it normally.
  // On failure, the message remains audio and falls through to the existing media_only path.
  //
  // Note: wwbun sends messageText as "[Audio]" placeholder for audio messages, not empty.
  // We ignore that placeholder and always try transcription for audio messages.
  if (isTranscriptionConfigured()) {
    for (const m of messages) {
      const type = (m.messageType || '').toLowerCase()
      if (type !== 'audio') continue

      let mediaUrl = m.mediaUrl
      if (!mediaUrl && m.wwbunMessageId) {
        console.log(`[Transcribe] ${whatsappNumber} — no mediaUrl, fetching for message ${m.wwbunMessageId}`)
        mediaUrl = await downloadMediaFromWwbun(m.wwbunMessageId)
      }
      if (!mediaUrl) {
        console.log(`[Transcribe] ${whatsappNumber} — audio message has no mediaUrl, will use media_only reply`)
        continue
      }

      const result = await transcribeAudio(mediaUrl)
      if (result && result.text) {
        console.log(`[Transcribe] ${whatsappNumber} — voice note → text: "${result.text.substring(0, 60)}…" (${getTranscriptionProvider()}, ${result.durationMs}ms)`)
        m.messageText = result.text
        m.messageType = 'text'
        m.hasMedia = false
        m.transcribedFrom = 'audio'
      } else {
        console.log(`[Transcribe] ${whatsappNumber} — voice note transcription failed, will use media_only reply`)
        // Clear "[Audio]" placeholder so downstream detects this as media-only and uses canned reply
        m.messageText = ''
      }
    }
  }

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

  // --- Skip [Unsupported] placeholder messages (view-once / poll / forwarded post WhatsApp
  // couldn't deliver) — Ketu disabled the wwbun "resend" auto-nudge for these ("most of the time
  // not required"); match that on the AI side. If the buyer's content is ONLY the unsupported
  // placeholder, log + skip (never auto-reply "resend kar dijiye"). If real text accompanies it,
  // fall through and answer the real text.
  const UNSUPPORTED_PLACEHOLDER = /\[unsupported\]\s*whatsapp could not deliver this message\s*\(often[^)]*\)\.?\s*ask the buyer to resend it normally\.?/gi
  const strippedUnsupported = (mergedText || '').replace(UNSUPPORTED_PLACEHOLDER, '').replace(/\[unsupported\]/gi, '').trim()
  if (mergedText && /could not deliver this message/i.test(mergedText) && strippedUnsupported.length < 4) {
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'SKIPPED',
      deferReason: 'unsupported_skipped',
      processingMs: Date.now() - startTime,
    })
    console.log(`[Unsupported] ${whatsappNumber} — unsupported-only message, logged + skipped (no resend nudge per Ketu)`)
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
      const sendResult = await sendReplyViaWwbun(whatsappNumber, mediaReply)
      await createLog(db, conversation.id, mergedText, messageIds, {
        status: 'REPLIED',
        aiReply: mediaReply,
        deferReason: 'bill_document',
        processingMs: Date.now() - startTime,
        isMedia: true,
        sentViaWwbun: !!sendResult,
        wwbunMessageId: sendResult?.messageId || null,
      })
      console.log(`[Partial AI] ${whatsappNumber} — bill document detected, replied with dispatch confirmation${sendResult ? '' : ' (SEND FAILED)'}`)
      return
    }

    // Invoice image detection (screenshot of purchase bill/tax invoice)
    // Also check documents sent as files (not just images)
    // If mediaUrl is null (batch media wasn't auto-downloaded), try on-demand download
    let invoiceMediaUrl = imageMediaUrl || documentMediaUrl
    if (!invoiceMediaUrl) {
      const mediaMsg = messages.find(m => (m.messageType === 'image' || m.messageType === 'document') && m.wwbunMessageId)
      if (mediaMsg) {
        console.log(`[Partial AI] ${whatsappNumber} — no mediaUrl, attempting on-demand download for message ${mediaMsg.wwbunMessageId}`)
        invoiceMediaUrl = await downloadMediaFromWwbun(mediaMsg.wwbunMessageId)
      }
    }
    if (invoiceMediaUrl && await isInvoiceImage(anthropic, invoiceMediaUrl)) {
      const mediaReply = 'Ok noted sir, dispatching ASAP 🚚'
      const sendResult = await sendReplyViaWwbun(whatsappNumber, mediaReply)
      await createLog(db, conversation.id, mergedText || '[invoice image]', messageIds, {
        status: 'REPLIED',
        aiReply: mediaReply,
        deferReason: 'bill_document',
        processingMs: Date.now() - startTime,
        isMedia: true,
        sentViaWwbun: !!sendResult,
        wwbunMessageId: sendResult?.messageId || null,
      })
      console.log(`[Partial AI] ${whatsappNumber} — invoice image detected, replied with dispatch confirmation${sendResult ? '' : ' (SEND FAILED)'}`)
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

    // --- Acid wash catalog auto-reply (exact match only) ---
    const acidWashNormalized = (mergedText?.trim() || '').toLowerCase()
      .replace(/[.!?,।]+$/g, '').trim()
      .replace(/\s+(sir|ji|bhai|bhaiya|boss|bro|sahab|saheb|g)$/i, '').trim()
    if (acidWashNormalized === 'i want to know about acid wash t-shirts'
      || acidWashNormalized === 'i want to know about acid wash tshirts'
      || acidWashNormalized === 'i want to know about acid wash t shirts'
      || acidWashNormalized === 'i want to know about acidwash t-shirts'
      || acidWashNormalized === 'i want to know about acidwash tshirts'
      || acidWashNormalized === 'i want to know about acidwash t shirts') {
      const acidWashReply = 'https://www.sale91.com/catalog/p/acidwash-oversize/\n\nAcidWash Cataloge👆'
      const sendResult = await sendReplyViaWwbun(whatsappNumber, acidWashReply)
      await createLog(db, conversation.id, mergedText, messageIds, {
        status: 'REPLIED',
        aiReply: acidWashReply,
        deferReason: 'acid_wash_catalog',
        processingMs: Date.now() - startTime,
        sentViaWwbun: !!sendResult,
        wwbunMessageId: sendResult?.messageId || null,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0,
      })
      console.log(`[Partial AI] ${whatsappNumber} — acid wash query, sent catalog link${sendResult ? '' : ' (SEND FAILED)'}`)
      return
    }

    // --- Catalog request auto-reply (partial AI) ---
    // Buyer explicitly asks for catalog → send link instantly, no AI involved.
    // Includes 2-min dedupe: if wwbun just sent the welcome (which already contains
    // the catalog link), skip to avoid sending the catalog twice in a row.
    const catalogReqKeywords = [
      'send catalog', 'share catalog', 'send the catalog', 'share the catalog',
      'send your catalog', 'share your catalog', 'please share your catalog',
      'please send catalog', 'send me catalog', 'send me the catalog',
      'i need catalog', 'i need the catalog', 'need catalog', 'need the catalog',
      'want catalog', 'want the catalog', 'show me catalog', 'show catalog',
      'catalog please', 'catalog link', 'catalog do', 'catalog dijiye',
      'catalog bhejo', 'catalog bhej', 'catalog send', 'catalog share',
      'catalog chahiye', 'cataloge', 'kataloge', 'catelog', 'katlog',
    ]
    const catalogLowerMsg = (mergedText || '').trim().toLowerCase()
    const matchedCatalogKw = catalogReqKeywords.find(kw => catalogLowerMsg.includes(kw))
    if (matchedCatalogKw && catalogLowerMsg.length <= 80) {
      // 2-min welcome dedupe — skip if welcome flow is still active
      const justGotWelcome = isWelcomeEligible
      const lastActivityMs = previousLastMessageAt ? (Date.now() - new Date(previousLastMessageAt).getTime()) : Infinity
      const inWelcomeWindow = lastActivityMs < 2 * 60 * 1000 && (conversation.messageCount || 0) <= 2
      if (justGotWelcome || inWelcomeWindow) {
        await createLog(db, conversation.id, mergedText, messageIds, {
          status: 'SKIPPED',
          deferReason: 'catalog_request_welcome_recent',
          processingMs: Date.now() - startTime,
        })
        console.log(`[Partial AI] ${whatsappNumber} — catalog request, but welcome just sent — skipping duplicate`)
        return
      }
      const catalogReply = 'https://sale91.com/catalog\n\nCheck rates and color once sir 👆'
      const sendResult = await sendReplyViaWwbun(whatsappNumber, catalogReply)
      await createLog(db, conversation.id, mergedText, messageIds, {
        status: 'REPLIED',
        aiReply: catalogReply,
        deferReason: 'catalog_request',
        processingMs: Date.now() - startTime,
        sentViaWwbun: !!sendResult,
        wwbunMessageId: sendResult?.messageId || null,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0,
      })
      console.log(`[Partial AI] ${whatsappNumber} — catalog request ("${matchedCatalogKw}"), sent catalog link${sendResult ? '' : ' (SEND FAILED)'}`)
      return
    }

    // --- Acknowledgement & greeting detection (same logic as Full AI) ---
    // Normalize text the same way Full AI does
    const partialNormalized = (mergedText || '').trim().toLowerCase()
      .replace(/[.!?,।]+$/g, '')
      .trim()
      .replace(/\s+(sir|ji|bhai|bhaiya|boss|bro|sahab|saheb|g)$/i, '')
      .trim()
    const partialNormalizedGreeting = (mergedText || '').trim().toLowerCase()
      .replace(/[.!?,।🙏👋]+/g, '')
      .trim()

    // Acknowledgements ("ok", "hmm", "yaa") → SKIP, no reply (same as Full AI)
    const partialAckPatterns = [
      'ok', 'okay', 'fine', 'sure', 'thanks', 'thank you', 'alright',
      'got it', 'noted', 'understood', 'no problem', 'np', 'cool',
      'great', 'good', 'right', 'yes', 'yep', 'ya', 'yaa',
      'theek hai', 'thik hai', 'accha', 'acha', 'sahi hai',
      'ji', 'haan', 'ha', 'dhanyavaad', 'shukriya', 'bas',
      'theek', 'thik', 'achchha', 'hmm', 'hm', 'k', 'kk',
      'done', 'bilkul', 'zaroor', 'thx', 'ty',
    ]
    if (partialAckPatterns.includes(partialNormalized)) {
      await createLog(db, conversation.id, mergedText, messageIds, {
        status: 'SKIPPED',
        deferReason: 'partial_ai_acknowledgment',
        processingMs: Date.now() - startTime,
      })
      console.log(`[Partial AI] ${whatsappNumber} — acknowledgement message, skipped (no reply needed)`)
      return
    }

    // Greetings ("hi", "hello") → reply with nudge
    const partialGreetingPatterns = [
      'hi', 'hello', 'hey', 'hii', 'hiii', 'hiiii',
      'helo', 'hlo', 'hllo', 'helloo', 'hellooo',
      'namaste', 'namaskar', 'namaskaar',
      'good morning', 'good afternoon', 'good evening',
      'gm', 'morning', 'evening', 'hy', 'hye', 'hola', 'yo',
    ]
    if (partialGreetingPatterns.includes(partialNormalizedGreeting)) {
      const sendResult = await sendReplyViaWwbun(whatsappNumber, WELCOME_FOLLOWUP_GENERIC)
      await createLog(db, conversation.id, mergedText, messageIds, {
        status: 'REPLIED',
        aiReply: WELCOME_FOLLOWUP_GENERIC,
        deferReason: 'partial_ai_greeting',
        processingMs: Date.now() - startTime,
        sentViaWwbun: !!sendResult,
        wwbunMessageId: sendResult?.messageId || null,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0,
      })
      console.log(`[Partial AI] ${whatsappNumber} — greeting message, replied with nudge${sendResult ? '' : ' (SEND FAILED)'}`)
      return
    }

    // --- Order dispatch text auto-reply (AI-based detection) ---
    if (mergedText?.trim()) {
      try {
        const detectResult = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{
            role: 'user',
            content: `Is this WhatsApp message an ORDER CONFIRMATION or DISPATCH REQUEST? The buyer is telling the seller that they placed an order and want it dispatched/shipped via porter or courier.\n\nExamples that are YES:\n- "bhaiya order place kiya h porter krwado"\n- "order ho gaya hai dispatch kardo"\n- "sir order place kiya dispatch kro urgent"\n- "payment done dispatch kardo"\n- "order kar diya bhej do"\n\nExamples that are NO:\n- "what is the price of oversize tshirt"\n- "acid wash available hai?"\n- "hi" / "hello"\n- "order cancel kardo" (this is cancellation, not confirmation)\n- "order ka status kya hai" (this is status inquiry)\n- "kahan tak aaya" (delivery tracking)\n\nBuyer message: "${mergedText.trim()}"\n\nReply only YES or NO.`,
          }],
        })
        const detectAnswer = detectResult.content?.[0]?.text?.trim().toUpperCase() || ''
        const detectTokens = {
          promptTokens: detectResult.usage?.input_tokens || 0,
          completionTokens: detectResult.usage?.output_tokens || 0,
          totalTokens: (detectResult.usage?.input_tokens || 0) + (detectResult.usage?.output_tokens || 0),
          costUsd: ((detectResult.usage?.input_tokens || 0) * PRICE_PER_INPUT_TOKEN) +
                   ((detectResult.usage?.output_tokens || 0) * PRICE_PER_OUTPUT_TOKEN),
        }
        console.log(`[Partial AI] ${whatsappNumber} — order dispatch AI detection: ${detectAnswer}`)
        if (detectAnswer.startsWith('YES')) {
          const dispatchReply = 'Ok sir, dispatching ASAP 🚚'
          const sendResult = await sendReplyViaWwbun(whatsappNumber, dispatchReply)
          await createLog(db, conversation.id, mergedText, messageIds, {
            status: 'REPLIED',
            aiReply: dispatchReply,
            deferReason: 'order_dispatch_text',
            processingMs: Date.now() - startTime,
            sentViaWwbun: !!sendResult,
            wwbunMessageId: sendResult?.messageId || null,
            ...detectTokens,
          })
          console.log(`[Partial AI] ${whatsappNumber} — order dispatch detected by AI, replied with dispatch confirmation${sendResult ? '' : ' (SEND FAILED)'}`)
          return
        }
      } catch (err) {
        console.error(`[Partial AI] ${whatsappNumber} — order dispatch detection error:`, err.message)
      }
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
              const sendResult = await sendReplyViaWwbun(whatsappNumber, WELCOME_FOLLOWUP_GENERIC)
              await createLog(db, conversation.id, mergedText, [], {
                status: 'REPLIED',
                aiReply: WELCOME_FOLLOWUP_GENERIC,
                deferReason: 'partial_ai_followup_generic',
                processingMs: 0,
                sentViaWwbun: !!sendResult,
                wwbunMessageId: sendResult?.messageId || null,
              })
              console.log(`[Partial AI Followup] ${whatsappNumber} — generic msg, sent nudge${sendResult ? '' : ' (SEND FAILED)'}`)
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
    const sendResult = await sendReplyViaWwbun(whatsappNumber, mediaReply)
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'REPLIED',
      aiReply: mediaReply,
      deferReason: 'bill_document',
      processingMs: Date.now() - startTime,
      isMedia: true,
      sentViaWwbun: !!sendResult,
      wwbunMessageId: sendResult?.messageId || null,
    })
    return
  }

  // --- Check: Invoice image (screenshot of purchase bill/tax invoice) ---
  // Also check documents sent as files (not just images)
  // If mediaUrl is null (batch media wasn't auto-downloaded), try on-demand download
  let invoiceMediaUrl = imageMediaUrl || documentMediaUrl
  if (!invoiceMediaUrl) {
    const mediaMsg = messages.find(m => (m.messageType === 'image' || m.messageType === 'document') && m.wwbunMessageId)
    if (mediaMsg) {
      console.log(`[Full AI] ${whatsappNumber} — no mediaUrl, attempting on-demand download for message ${mediaMsg.wwbunMessageId}`)
      invoiceMediaUrl = await downloadMediaFromWwbun(mediaMsg.wwbunMessageId)
    }
  }
  if (invoiceMediaUrl && await isInvoiceImage(anthropic, invoiceMediaUrl)) {
    const mediaReply = 'Ok noted sir, dispatching ASAP 🚚'
    const sendResult = await sendReplyViaWwbun(whatsappNumber, mediaReply)
    await createLog(db, conversation.id, mergedText || '[invoice image]', messageIds, {
      status: 'REPLIED',
      aiReply: mediaReply,
      deferReason: 'bill_document',
      processingMs: Date.now() - startTime,
      isMedia: true,
      sentViaWwbun: !!sendResult,
      wwbunMessageId: sendResult?.messageId || null,
    })
    console.log(`[Full AI] ${whatsappNumber} — invoice image detected, replied with dispatch confirmation${sendResult ? '' : ' (SEND FAILED)'}`)
    return
  }

  // A non-invoice product photo the clone can SEE (vision). null if the media isn't an image.
  const productImageUrl = messages.some(m => m.messageType === 'image') ? invoiceMediaUrl : null

  // --- Check: Media-only message (image/audio/video/document the AI can't process) ---
  // If it's a product PHOTO, let the AI see it (vision) and reply about it. Otherwise (video,
  // un-transcribable audio, etc.) DEFER to Ketu — he sees the media in wwbun and handles it.
  if (hasMediaOnly) {
    if (productImageUrl) {
      console.log(`[Full AI] ${whatsappNumber} — product photo (no caption), running AI with vision`)
      await runAiFlow({
        whatsappNumber, mergedText: '', quotedText, conversationId: conversation.id,
        normalizedText: '', db, anthropic, settings, startTime, messageIds, imageUrl: productImageUrl,
      })
      return
    }
    scheduleDeferReply({
      whatsappNumber, deferMessage: settings.deferMessage, conversationId: conversation.id,
      mergedText: mergedText || '[media]', messageIds, logData: {
        status: 'DEFERRED',
        deferReason: 'media_deferred',
        processingMs: Date.now() - startTime,
        isMedia: true,
      }, db,
    })
    console.log(`[Full AI] ${whatsappNumber} — media-only (can't process), deferred to Ketu`)
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

  // --- Acid wash catalog auto-reply (exact match only) ---
  if (normalizedText === 'i want to know about acid wash t-shirts'
    || normalizedText === 'i want to know about acid wash tshirts'
    || normalizedText === 'i want to know about acid wash t shirts'
    || normalizedText === 'i want to know about acidwash t-shirts'
    || normalizedText === 'i want to know about acidwash tshirts'
    || normalizedText === 'i want to know about acidwash t shirts') {
    const acidWashReply = 'https://www.sale91.com/catalog/p/acidwash-oversize/\n\nAcidWash Cataloge👆'
    const sendResult = await sendReplyViaWwbun(whatsappNumber, acidWashReply)
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'REPLIED',
      aiReply: acidWashReply,
      deferReason: 'acid_wash_catalog',
      processingMs: Date.now() - startTime,
      sentViaWwbun: !!sendResult,
      wwbunMessageId: sendResult?.messageId || null,
      promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0,
    })
    console.log(`[Full AI] ${whatsappNumber} — acid wash query, sent catalog link${sendResult ? '' : ' (SEND FAILED)'}`)
    return
  }

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
        const sendResult = await sendReplyViaWwbun(whatsappNumber, replyText)
        await createLog(db, conversation.id, mergedText, messageIds, {
          status: 'REPLIED',
          deferReason: filter.name,
          aiReply: replyText,
          processingMs: Date.now() - startTime,
          sentViaWwbun: !!sendResult,
          wwbunMessageId: sendResult?.messageId || null,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        })
        console.log(`[${filter.displayName}] ${whatsappNumber} — auto-replied, 0 tokens${sendResult ? '' : ' (SEND FAILED)'}`)
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
          const sendResult = await sendReplyViaWwbun(whatsappNumber, WELCOME_FOLLOWUP_GENERIC)
          await createLog(db, conversation.id, mergedText, [], {
            status: 'REPLIED',
            aiReply: WELCOME_FOLLOWUP_GENERIC,
            deferReason: 'welcome_followup_generic',
            processingMs: 0,
            sentViaWwbun: !!sendResult,
            wwbunMessageId: sendResult?.messageId || null,
          })
          console.log(`[Followup] ${whatsappNumber} — generic msg, sent nudge${sendResult ? '' : ' (SEND FAILED)'}`)
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
  await runAiFlow({ whatsappNumber, mergedText, quotedText, conversationId: conversation.id, normalizedText, db, anthropic, settings, startTime, messageIds, imageUrl: productImageUrl })

  } finally {
    // If there's a pending defer with no active timer (paused by new message arrival),
    // and this processing didn't reschedule or cancel it, restart the timer
    restartDeferTimer(whatsappNumber)
  }
}

// ===========================================
// BOOT RECOVERY: fire welcome-followups dropped by a server restart
// ===========================================
// The 3-min welcome-followup is an in-memory setTimeout (pendingWelcomeFollowups).
// A redeploy/restart wipes every pending timer, so buyers who messaged in that window
// never get their followup (~15% orphan rate observed). On boot we sweep for
// welcome_followup_scheduled logs whose timer would have elapsed (>3 min ago) but never
// fired (no later activity in that conversation), and fire them now — mirroring the
// timer's own logic. Guards: AI must be active; cooldown (Ketu intervened) skips so we
// never talk over a manual reply; only the latest scheduled row per conversation; bounded
// time window + count. Firing writes a log, so it won't re-fire on the next boot.
export async function recoverPendingFollowups({ db, anthropic }) {
  try {
    const settings = await db.settings.findUnique({ where: { id: 'default' } })
    if (!settings?.isActive) {
      console.log('[FollowupRecovery] AI inactive — skipping sweep')
      return
    }
    const now = Date.now()
    // Tight window: cooldown is only ~10 min, so recovering rows older than that risks
    // re-messaging a chat Ketu already closed manually (cooldown expired). Restart-orphans
    // are only minutes old when this runs, so 15 min covers them with margin.
    const windowStart = new Date(now - 15 * 60 * 1000)  // don't recover anything older than 15 min
    const fireBefore = new Date(now - THREE_MINUTES_MS)  // timer would already have fired
    const scheduled = await db.messageLog.findMany({
      where: {
        deferReason: 'welcome_followup_scheduled',
        createdAt: { gte: windowStart, lte: fireBefore },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, conversationId: true, buyerMessage: true, createdAt: true },
    })
    if (!scheduled.length) { console.log('[FollowupRecovery] none pending'); return }

    // Keep only the latest scheduled row per conversation
    const latestPerConv = new Map()
    for (const row of scheduled) {
      if (!latestPerConv.has(row.conversationId)) latestPerConv.set(row.conversationId, row)
    }

    let recovered = 0, skipped = 0
    const MAX_RECOVER = 25
    for (const row of latestPerConv.values()) {
      if (recovered >= MAX_RECOVER) { console.log('[FollowupRecovery] hit per-boot cap (25)'); break }
      // Anything logged after the scheduled row means the conversation moved on / followup fired
      const laterLog = await db.messageLog.findFirst({
        where: { conversationId: row.conversationId, createdAt: { gt: row.createdAt } },
        select: { id: true },
      })
      if (laterLog) { skipped++; continue }
      const convo = await db.buyerConversation.findUnique({
        where: { id: row.conversationId },
        select: { whatsappNumber: true, cooldownUntil: true },
      })
      if (!convo?.whatsappNumber) { skipped++; continue }
      // Ketu replied manually → /api/intervention set a cooldown → don't talk over him
      if (convo.cooldownUntil && new Date() < new Date(convo.cooldownUntil)) { skipped++; continue }

      const mergedText = row.buyerMessage || ''
      try {
        if (isGenericMessage(mergedText)) {
          const sendResult = await sendReplyViaWwbun(convo.whatsappNumber, WELCOME_FOLLOWUP_GENERIC)
          await createLog(db, row.conversationId, mergedText, [], {
            status: 'REPLIED', aiReply: WELCOME_FOLLOWUP_GENERIC,
            deferReason: 'welcome_followup_recovered_generic', processingMs: 0,
            sentViaWwbun: !!sendResult, wwbunMessageId: sendResult?.messageId || null,
          })
        } else {
          await runAiFlow({
            whatsappNumber: convo.whatsappNumber, mergedText, quotedText: null,
            conversationId: row.conversationId, normalizedText: mergedText.trim().toLowerCase(),
            db, anthropic, settings, startTime: now, messageIds: [],
          })
        }
        recovered++
        console.log(`[FollowupRecovery] fired for ${convo.whatsappNumber}: "${mergedText.slice(0, 40)}"`)
      } catch (err) {
        console.error(`[FollowupRecovery] error for ${convo.whatsappNumber}:`, err.message)
      }
    }
    console.log(`[FollowupRecovery] done — recovered ${recovered}, skipped ${skipped}, candidates ${latestPerConv.size}`)
  } catch (err) {
    console.error('[FollowupRecovery] sweep failed:', err.message)
  }
}

// ===========================================
// AI Flow: Vector Search → Claude → Reply
// Reusable by both main pipeline and welcome follow-up
// ===========================================
async function runAiFlow({ whatsappNumber, mergedText, quotedText, conversationId, normalizedText, db, anthropic, settings, startTime, messageIds, imageUrl = null }) {
  // --- Product-photo vision: load the image so Claude can SEE it (null if none/failed/unsupported) ---
  const imageBlock = imageUrl ? await fetchImageBlock(imageUrl) : null
  if (imageUrl && !imageBlock && !(mergedText && mergedText.trim())) {
    // Image-only message but the photo couldn't be loaded → fall back to the old safe behaviour (defer).
    scheduleDeferReply({
      whatsappNumber, deferMessage: settings.deferMessage, conversationId,
      mergedText: '[media]', messageIds, logData: {
        status: 'DEFERRED', deferReason: 'media_deferred', processingMs: Date.now() - startTime, isMedia: true,
      }, db,
    })
    console.log(`[Vision] ${whatsappNumber} — image-only but load failed, deferred to Ketu`)
    return
  }
  // Photo with no real caption → give downstream (logs / gate) a sane label. Retrieval is skipped
  // for these (the label carries no product signal — see knowledgeResults below). IMPORTANT: a
  // bare media PLACEHOLDER ("[Image]", "[Audio]", "[media]" etc.) counts as "no caption" — otherwise
  // RAG runs on "[Image]" and matches a poison "[Image]"-keyed correction at 1.000 (this caused the
  // "Polo t-shirt" hallucination on a photo-less message).
  const isMediaPlaceholder = (t) => /^\s*\[(image|images|photo|audio|voice|video|media|document|sticker|gif)\]\s*$/i.test(t || '')
  const captionlessPhoto = !!(imageBlock && (!(mergedText && mergedText.trim()) || isMediaPlaceholder(mergedText)))
  if (captionlessPhoto) mergedText = '[product photo]'

  // ============================================================
  // REPLY RESTRAINT (Full AI only — runAiFlow is never called in partial mode)
  // Goal: reply like Om — once, precisely, or not at all. No 20-replies-to-20-messages storms.
  // ============================================================

  // Safety backstop: hard cap on AI replies to one buyer per day (runaway-cost guard).
  const REPLY_DAILY_CAP = 25
  const dayStart = new Date(new Date().setHours(0, 0, 0, 0))
  const repliesToday = await db.messageLog.count({
    where: { conversationId, status: 'REPLIED', createdAt: { gte: dayStart }, totalTokens: { gt: 0 } },
  })
  if (repliesToday >= REPLY_DAILY_CAP) {
    await createLog(db, conversationId, mergedText, messageIds, {
      status: 'SKIPPED', deferReason: 'daily_reply_cap', processingMs: Date.now() - startTime,
    })
    console.log(`[Restraint] ${whatsappNumber} — daily reply cap (${REPLY_DAILY_CAP}) hit, staying silent`)
    return
  }

  // (B + C) "Would Om reply to this, or stay silent?" — a cheap Haiku gate BEFORE the expensive
  // RAG + reply. Skips acks/chatter/thinking-out-loud and avoids piling on right after a reply.
  // This is what makes the clone reply once and precisely, and it saves cost on no-reply messages.
  try {
    const recentForGate = await db.messageLog.findMany({
      where: { conversationId, status: { in: ['REPLIED', 'DEFERRED'] } },
      orderBy: { createdAt: 'desc' }, take: 4,
      select: { buyerMessage: true, aiReply: true },
    })
    const histText = recentForGate.slice().reverse()
      .map(h => `Buyer: ${h.buyerMessage}\nOm: ${h.aiReply || '(no reply)'}`).join('\n')
    const gate = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 5,
      messages: [{ role: 'user', content: `You decide whether Om — a busy wholesale t-shirt seller — would REPLY to the buyer's latest WhatsApp message, or stay SILENT.

REPLY when the buyer asks a real question or needs a response: rates, products, sizes, colours, MOQ, availability, how to order, location, payment, an issue/complaint, or anything that clearly expects an answer.

Stay SILENT when the message is just: an acknowledgement ("ok", "thik hai", "thanks", "hmm", "👍"), thinking out loud, small talk, a reaction, something already answered, or chatter that needs no reply. Also stay SILENT if Om just replied moments ago and this new message adds no real new question (don't pile on).

${histText ? `Recent conversation:\n${histText}\n\n` : ''}Buyer's latest message: "${mergedText}"${imageBlock ? '\n(The buyer attached a PRODUCT PHOTO — Om would look at it and reply.)' : ''}

Answer with ONLY one word: REPLY or SILENT.` }],
    })
    const verdict = (gate.content?.[0]?.text || '').trim().toUpperCase()
    const gateCost = ((gate.usage?.input_tokens || 0) * PRICE_PER_INPUT_TOKEN) + ((gate.usage?.output_tokens || 0) * PRICE_PER_OUTPUT_TOKEN)
    await db.settings.update({ where: { id: 'default' }, data: { dailySpentUsd: { increment: gateCost } } }).catch(() => {})
    if (verdict.startsWith('SILENT')) {
      await createLog(db, conversationId, mergedText, messageIds, {
        status: 'SKIPPED', deferReason: 'ai_chose_silence',
        promptTokens: gate.usage?.input_tokens || 0, completionTokens: gate.usage?.output_tokens || 0,
        totalTokens: (gate.usage?.input_tokens || 0) + (gate.usage?.output_tokens || 0), costUsd: gateCost,
        processingMs: Date.now() - startTime,
      })
      console.log(`[Restraint] ${whatsappNumber} — gate: SILENT (Om wouldn't reply), $${gateCost.toFixed(6)}`)
      return
    }
    console.log(`[Restraint] ${whatsappNumber} — gate: REPLY`)
  } catch (err) {
    // Gate failure must NEVER block a real reply — fall through to the normal flow on error.
    console.error(`[Restraint] ${whatsappNumber} — gate error (replying anyway):`, err.message)
  }

  // --- VECTOR SEARCH: Single search across all 4 knowledge sources ---
  // confidenceThreshold gates which chunks reach Claude. Fallback to deprecated deferThreshold for
  // users who set the old field, then to a safe 0.55 default if neither is configured.
  const confidenceThreshold = Number(settings.confidenceThreshold ?? settings.deferThreshold ?? 0.55)

  const allVectorResults = await vectorSearch(db, anthropic, mergedText, {
    limit: 10,  // fetch extra so corrections can be boosted into top 5
    minSimilarity: 0.0,
    excludeSources: ['STYLE_GUIDE', 'STYLE_PAIR', 'PREMIUM_PAIR'],
  })

  const bestSimilarity = allVectorResults.length > 0
    ? Math.max(...allVectorResults.map(r => Number(r.similarity)))
    : 0

  // Boost CORRECTION results BEFORE applying threshold — corrections are Om's manual fixes
  // and should be able to clear the bar even if their raw similarity was slightly below it.
  const boostedResults = allVectorResults.map(r => ({
    ...r,
    similarity: r.source === 'CORRECTION' ? Math.min(Number(r.similarity) + 0.15, 1.0) : Number(r.similarity),
    boosted: r.source === 'CORRECTION',
  }))
  boostedResults.sort((a, b) => b.similarity - a.similarity)
  // Apply confidence threshold after boost; weak matches are dropped so Claude sees less noise.
  const knowledgeResults = captionlessPhoto
    ? []  // caption-less photo: query is just '[product photo]', so injecting any CATALOG match would be a guess
    : boostedResults.filter(r => r.similarity >= confidenceThreshold).slice(0, 5)
  if (knowledgeResults.length === 0 && allVectorResults.length > 0) {
    console.log(`[Vector] ${whatsappNumber} — best match ${(bestSimilarity * 100).toFixed(1)}% below threshold ${(confidenceThreshold * 100).toFixed(0)}%; Claude will likely defer`)
  }
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

  const { staticPrompt, dynamicPrompt } = buildSystemPrompt({ settings, styleGuide, stylePairs: stylePairResults })
  const systemPrompt = staticPrompt + dynamicPrompt  // combined, for logging/grading
  // Prompt-cache the static prefix (1h TTL — see extendedCacheTtlAvailable); keep the per-query
  // dynamic part as a separate uncached block. buildSystemBlocks(ttl1h) lets us retry without it.
  const buildSystemBlocks = (use1h) => {
    const cc = use1h ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
    const blocks = [{ type: 'text', text: staticPrompt, cache_control: cc }]
    if (dynamicPrompt) blocks.push({ type: 'text', text: dynamicPrompt })
    return blocks
  }
  let userPrompt = buildUserPrompt({
    mergedText,
    knowledgeResults,
    stylePairResults,
    conversationHistory,
    quotedText,
  })

  // Vision: tell the model a real photo is attached and how to use it (no hallucinated prices/details).
  if (imageBlock) {
    userPrompt = `📷 The buyer attached a PHOTO (sent with this message). Look at the image carefully.\nFIRST: if the photo is clearly NOT apparel / a garment / a product we could sell (a selfie, a meme, a screenshot of text or chat, a document, a random object), OR if the image is blank / unclear / blurry / you cannot actually make out a garment, reply with EXACTLY [DEFER] and nothing else — do NOT guess.\nOTHERWISE, identify which of our products it is (tshirt / oversized / polo / hoodie / sweatshirt / acid wash / drop shoulder / etc.) ONLY if you are genuinely confident from what you SEE. Reply about THAT product the way Om would: if it clearly matches something we make, say so briefly and send the catalog link https://sale91.com/catalog (use a specific product link only if one is given in the knowledge base above). If you are NOT sure which product it is, do NOT name one — ask "Kaunsa product chahiye sir?" instead of guessing a type (e.g. never say "polo" unless you can clearly see a collar). NEVER invent a price, GSM, or detail not in the knowledge base, and never claim it is in/out of stock.\n\n${userPrompt}`
  }

  // --- Call Claude API ---
  let aiReply
  let promptTokens, completionTokens, totalTokens, costUsd

  try {
    const userMessages = [{ role: 'user', content: imageBlock ? [imageBlock, { type: 'text', text: userPrompt }] : userPrompt }]
    let response
    // Try the 1-hour cache TTL first (bigger savings); if the beta is rejected, disable it for the
    // rest of the process and fall back to the standard 5-min ephemeral cache — never breaks a reply.
    if (extendedCacheTtlAvailable) {
      try {
        response = await anthropic.messages.create(
          { model: 'claude-sonnet-4-6', max_tokens: 500, system: buildSystemBlocks(true), messages: userMessages },
          { headers: { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } }
        )
      } catch (e) {
        console.error('[Cache] 1h TTL unavailable, falling back to 5-min ephemeral:', e.message)
        extendedCacheTtlAvailable = false
      }
    }
    if (!response) {
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 500, system: buildSystemBlocks(false), messages: userMessages,
      })
    }

    aiReply = response.content[0].text
    // With prompt caching the usage splits into fresh input, cache writes (1.25x) and cache reads (0.1x).
    const u = response.usage
    const freshInput = u.input_tokens || 0
    const cacheWrite = u.cache_creation_input_tokens || 0
    const cacheRead = u.cache_read_input_tokens || 0
    promptTokens = freshInput + cacheWrite + cacheRead
    completionTokens = u.output_tokens
    totalTokens = promptTokens + completionTokens
    // 1h cache writes cost 2x input; 5-min writes cost 1.25x. Reads are 0.1x either way.
    const writeMultiplier = extendedCacheTtlAvailable ? 2.0 : 1.25
    costUsd = (freshInput * REPLY_PRICE_PER_INPUT_TOKEN)
      + (cacheWrite * REPLY_PRICE_PER_INPUT_TOKEN * writeMultiplier)
      + (cacheRead * REPLY_PRICE_PER_INPUT_TOKEN * 0.10)
      + (completionTokens * REPLY_PRICE_PER_OUTPUT_TOKEN)
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

  // --- Final cooldown re-check before sending (intervention race) ---
  // Generation (vector search + Claude) takes a few seconds — sometimes longer. If Om manually
  // replied DURING that window, his /api/intervention set a cooldown. Without this re-check the AI
  // would send its now-redundant reply on top of Om's (the duplicate "HD Photos" link bug). So if a
  // cooldown is active here, suppress the send and log it as superseded.
  const preSendCooldown = await db.buyerConversation.findUnique({
    where: { whatsappNumber },
    select: { cooldownUntil: true },
  })
  if (preSendCooldown?.cooldownUntil && new Date() < new Date(preSendCooldown.cooldownUntil)) {
    cancelPendingDefer(whatsappNumber)
    await createLog(db, conversationId, mergedText, messageIds, {
      status: 'SKIPPED',
      deferReason: 'superseded_by_intervention',
      aiReply,
      promptTokens, completionTokens, totalTokens, costUsd,
      processingMs: Date.now() - startTime,
    })
    await db.settings.update({ where: { id: 'default' }, data: { dailySpentUsd: { increment: costUsd } } })
    console.log(`[Full AI] ${whatsappNumber} — Om intervened during generation; suppressing duplicate reply`)
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
  // Split into a STATIC part (prompt-cached) and a DYNAMIC part (per-query, not cached).
  // The static part — base prompt + Om's style guide — is identical on every reply, so caching it
  // (Anthropic cache reads = 10% of input price) roughly halves the input cost. The dynamic part
  // (similar-conversation examples from vector search) varies per query, so it must stay UNcached
  // (caching it would change the cached content each call and miss every time).
  let staticPrompt = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT
  if (styleGuide) {
    staticPrompt += `\n\nOM'S COMMUNICATION STYLE:\n${styleGuide}`
  }

  let dynamicPrompt = ''
  if (stylePairs && stylePairs.length > 0) {
    dynamicPrompt += `\n\nSIMILAR PAST CONVERSATIONS (reply like Om — match his tone, length, and style):\n`
    for (const pair of stylePairs) {
      const meta = typeof pair.metadata === 'string' ? JSON.parse(pair.metadata) : pair.metadata
      if (meta?.buyerMessage && meta?.omReply) {
        dynamicPrompt += `Buyer: ${meta.buyerMessage}\nOm: ${meta.omReply}\n\n`
      }
    }
  }

  return { staticPrompt, dynamicPrompt }
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
        // Inject the real deep product link so the bot can send it (like Om does) instead of
        // guessing a slug. The slug comes from catalog metadata; never let the model invent URLs.
        if (meta.slug) prompt += `Product link: https://sale91.com/catalog/p/${meta.slug}\n`
        if (meta.gsm) prompt += `GSM: ${meta.gsm}\n`
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
    console.error('[Send] WWBUN_API_URL or DIGITAL_KETU_SECRET not configured — message NOT sent to', whatsappNumber)
    return null
  }

  const MAX_RETRIES = 2
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
        let errorBody = ''
        try { errorBody = await response.text() } catch (_) {}
        console.error(`[Send] wwbun API error (attempt ${attempt}/${MAX_RETRIES}): ${response.status} ${response.statusText} — ${whatsappNumber} — body: ${errorBody}`)
        if (attempt < MAX_RETRIES && response.status >= 500) {
          await new Promise(r => setTimeout(r, 1000 * attempt))
          continue
        }
        return null
      }

      const result = await response.json()
      if (attempt > 1) console.log(`[Send] ${whatsappNumber} — succeeded on retry attempt ${attempt}`)
      return result
    } catch (err) {
      console.error(`[Send] Failed to send via wwbun (attempt ${attempt}/${MAX_RETRIES}): ${whatsappNumber} — ${err.message}`)
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * attempt))
        continue
      }
      return null
    }
  }
  return null
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
