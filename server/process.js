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
import { evaluateIgGate } from './ig-gate.js'
import { lookupOrdersByPhone, formatOrderLookupBlock, getBuyerProfile, formatBuyerProfileBlock } from './order-lookup.js'
import { getStockSnapshot, formatStockBlock } from './stock-lookup.js'
import { openaiReply, isOpenAiFallbackConfigured } from './openai-fallback.js'

// ===========================================
// Welcome Follow-Up Constants & State
// ===========================================
// Was 3 minutes; cut to 60s on Ketu's call (2026-07-06): buyers got the "any questions?" nudge
// or their first answer 3 min late and disengaged. 60s still lets a multi-message first burst
// finish and still gives Ketu first shot (his manual reply cancels the timer via cooldown).
const WELCOME_FOLLOWUP_DELAY_MS = 60 * 1000  // 1 minute — Ketu-tuned; was misnamed WELCOME_FOLLOWUP_DELAY_MS
const DEFER_DELAY_MS = 30 * 1000 // 30 seconds — batch defers before sending
// Welcome follow-up nudge after a bare greeting ("hi"/"hello" with no question). Ketu WANTS this
// "any questions?" engagement nudge here — do NOT replace it with the catalog link. The BANNED FILLER
// rule in the system prompt applies to the AI's GENERATED replies (don't dodge a real question with
// empty filler), NOT to this canned nudge that follows a content-less greeting.
const WELCOME_FOLLOWUP_GENERIC = 'Ask me if any questions sir?'
export const pendingWelcomeFollowups = new Map() // keyed by whatsappNumber
export const pendingDefers = new Map() // keyed by whatsappNumber
// whatsappNumber -> ms of the last reply actually SENT via wwbun. Lets the /api/incoming caller
// distinguish "a reply just went out this turn" (badge already cleared by send-ai-reply) from a
// genuine skip (needs clearing) — without threading a return status through processIncomingMessage's
// ~30 bare-return exit points. Set by sendReplyViaWwbun on success.
export const lastReplySentAt = new Map()

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
        // The deferred reply won't go out — clear wwbun's "preparing a reply" badge.
        notifySkippedViaWwbun(whatsappNumber)
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
// Instagram DM bridge — all IG behavior is guarded behind the 'ig:' conversation-key prefix.
// IG_BUSINESS_ID / IG_VERIFY_TOKEN are exported for the /ig/webhook handlers in index.js.
const IG_MSG_TOKEN = process.env.IG_MSG_TOKEN
export const IG_BUSINESS_ID = process.env.IG_BUSINESS_ID
export const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN

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
            text: 'Is this a FINALIZED purchase BILL / tax INVOICE / payment RECEIPT — a generated document with a bill/invoice number, or a completed-payment confirmation (e.g. a UPI/bank "payment successful" screen)? A screenshot of a WEBSITE, shopping CART, CHECKOUT page, an "Order Now" / "Add to cart" / "Place order" button, or a product listing is NOT a bill (the buyer hasn\'t paid yet) — reply NO for those. Reply only YES or NO.',
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

// A buyer chasing a DELAYED / late order ("abhi tak dispatch nahi hua", "itni late kyun", "kab aayega",
// "X din ho gaye", "order kahan hai") is a STATUS matter only Ketu can truthfully answer. So when a bill /
// invoice arrives in THAT context, it must NOT trigger the canned "dispatching ASAP" — that ignores the
// complaint and may be untrue. Defer to Ketu instead (Ketu 2026-06-08, buyer 919163331280).
const DELAY_COMPLAINT_RE = /abhi\s*t[ak]+\b[^]{0,25}\b(nahi|nhi|nahin|nehi|nai)|dispatch\s*(nahi|nhi|nahin|nehi|nai)\s*hua|\b(nahi|nhi|nehi|nai)\s*hua\b|itni\s*(late|der|deri)|(kyu|kyun|q)\b[^]{0,20}\b(late|der)\b|\b(kab|kaha|kahan)\b[^]{0,20}\b(aa?yega|aega|tak|hai|hoga)|\d+\s*din\s*(ho|hue|huye)[^]{0,8}(gaye|gae|gaya|gye|hai)|\bdelay\b|late\s*ho\s*rah/i

// A bill/invoice can also arrive with TEXT whose intent is NOT a dispatch confirmation at all —
// RETURN / REFUND / CANCEL / closing-the-business buy-back ("stock return kar sakte hain?",
// "business band karna pad raha hai", "refund kar do", "cancel kar do", "wapas le lo"). The canned
// "dispatching ASAP" to such a message ignores (and insults) the actual request — honor the TEXT
// and defer to Ketu (Ketu 2026-06-11, buyer 917771860806: closing business, asked to return stock,
// got "dispatching ASAP").
// Includes MISSING-PIECE / short-shipment complaint phrasings (2026-07-05, buyer 6353441274:
// "ordered 2 pcs & received only 1 pcs" — a bill + such TEXT must defer, not "dispatching ASAP").
const NON_DISPATCH_INTENT_RE = /\breturn\b|\brefund\b|\bcancel\b|\bexchange\b|\breplace\b|wapas|वापस|लौटा|रिफंड|कैंसल|रिटर्न|band\s*(karna|kar\s*rah|ho\s*rah)|बंद\s*(करना|कर\s*रह|हो\s*रह)|बदल\s*(do|दो|na|ना)|received only|\bonly\s*\d+\s*(pc|pcs|piece)|sirf\s*\d+\s*(aaya|aaye|mila|mile)|kam\s*(mila|mile|aaya|aaye|nikla|nikle|hai|the)\b|(pc|pcs|piece[s]?)\s*kam\b|\bmissing\b|\bshort\s*(aaya|mila|received)|नहीं\s*(आया|आये|मिला|मिले)|कम\s*(मिला|मिले|आया|आये|निकला|निकले)|\bwrong\s*(size|colour|color|item)|galat\s*(size|colour|color|item|maal)|गलत\s*(साइज|कलर|आइटम|माल)/i
function hasNonDispatchIntentText(text) {
  return NON_DISPATCH_INTENT_RE.test(text || '')
}

// A bill/invoice image can ALSO arrive alongside a plain INFO REQUEST — "send me location",
// "office address?", "ye number update kar do (phone off hai)". The canned "dispatching ASAP"
// ignores the actual ask (11-Jul 16:48: buyer sent an image + "Send me location" and got
// "dispatching ASAP"; Ketu then handled a phone-number change himself). These want an answer or a
// human, never a dispatch ack — so defer to Ketu instead of firing the canned reply.
// Covers: info-requests (location/address), contact/number changes, AND order MODIFICATIONS that
// arrive with a bill/invoice image — add-an-item ("dal dena ismei", "ye bhi add kar do") and
// bill/slip REQUESTS ("plz bill", "slip chahiye"). All of these must DEFER, never "dispatching ASAP"
// (audit 2026-07-16: the clone dispatch-acked "[Image] Dal dena ismei wo piece" and "Plz bill").
const NON_DISPATCH_REQUEST_RE = /\b(location|address|adress|adres)\b|पता|लोकेशन|send\s*(me\s*)?(the\s*)?(location|address)|share\s*(your\s*)?location|naya\s*(number|no\b|contact|nmbr|numbr)|(number|no\.?|contact|phone|mobile|numbr)\s*(update|change|badal|badlo|sahi|galat|naya|band)|(number|no\.?|contact|phone|mobile)\s*(is\s*)?off\b|(update|change|badal|badlo)\s*(this\s*)?(number|no\.?|contact)|\b(number|contact|phone|mobile|numbr)\b[^]{0,20}\b(update|change|badal|badlo|sahi\s*kar)\b|\bdaa?l\s*(dena|do|dijiye)\b|add\s*(kar|kr)\s*(do|dena|dijiye|na)\b|ye\s*bhi\s*(daa?l|add|lga)|isme\s*(daa?l|add|lga)|ek\s*(aur|or)\b[^]{0,18}\b(piece|pcs|item|add|daa?l)|\b(bill|slip|receipt|invoice)\s*(chahiye|chaiye|bhej|send|do\b|dena|dijiye|de\s*do|plz|please)|\b(plz|please|pls)\s*(bill|slip|invoice)\b/i
function hasNonDispatchRequestText(text) {
  return NON_DISPATCH_REQUEST_RE.test(text || '')
}

// BUDGET-CAP CATALOG FALLBACK (2026-07-21, UK buyer 447776833983: "I'm looking for combed cotton
// bio-washed oversized plain tshirt" got the bare "Ketu will reply shortly" at 8:21pm — NOT because
// it was an international number, but because the ₹750 daily budget was exhausted by ~7:25pm and
// EVERY buyer after that gets the free defer line). A clear SHOPPING question (products / rates /
// details / "looking for X") can still be served a zero-cost deterministic catalog link even when
// the AI budget is spent. isShoppingInquiry() = looks like shopping AND is NOT a complaint / order /
// tracking / modification (those still defer to Ketu — only he handles them).
const SHOPPING_RE = /\b(t[\s-]?shirt|tshirt|tees?|oversize[d]?|polo|hoodie|sweat\s?shirt|cotton|jersey|bio\s*wash|biowash|non\s*bio|true\s*bio|gsm|acid\s*wash|acidwash|drop\s*shoulder|round\s*neck|r\s*neck|rneck|varsity|shorts|kids|sublimation|catalog|catalogue|rate\s*list|price\s*list|rates?|price|details|sample|colou?r|plain|combed|fabric|moq|wholesale|bulk)\b|chahiye|chahie|looking\s*for|requirement|intereste?d|\bwant\b|\bneed\b|banate\s*ho|karte\s*ho|dikha(o|iye)/i
// KNOWN not-made items — bottom-wear (except shorts) + outerwear jackets etc. On budget-cap these
// must get "nahi banate" (Ketu's verified answer + Indiamart routing), NOT a catalog link that
// wrongly implies we sell them (Ketu 2026-07-22, buyer 8903716175: "Do you have track pants?" got
// deferred because the ₹750 budget was spent; his manual reply was "No sir. We do not"). Checked
// BEFORE the shopping/catalog fallback. Shorts are ours, so excluded.
const NOT_MADE_RE = /track\s*-?pant|trackpant|\blower(s)?\b|pajama|pyjama|trouser|\bjeans\b|jogger|palazzo|blazer|denim\s*jacket|varsity\s*jacket|cargo\s*pant|night\s*pant|full[\s-]*pant|\bpants\b|\bsando\b|sandow|\bsendo\b|baniyan|baniyaan|\bvest\b|tank\s*top|\bganji\b/i
// Made-product NOUNS only (no verbs) — used to tell a PURE not-made ask ("lower chahiye") from a
// mixed one ("track pant aur tshirt", which should still get the catalog for the tshirt part).
const PRODUCT_NOUN_RE = /\b(t[\s-]?shirt|tshirt|tees?|oversize[d]?|polo|hoodie|sweat\s?shirt|round\s*neck|r\s*neck|rneck|drop\s*shoulder|acid\s*wash|acidwash|sublimation|shorts|kids)\b/i
const THANKS_RE = /\b(thank\s*(you|u)?|thanks|thankyou|thnx|thx|tysm|shukriya|dhanyawad|dhanyavad)\b/i
// COD question → a real deterministic answer (Ketu 2026-07-22, buyer 8848602563: "cash on
// delivery?" got the bare defer; Ketu answered COD IS available, via the website's courier-address
// option). CUSTOMIZATION / PRINTING / "suggest me someone" → must NOT get a catalog link (Ketu
// 2026-07-22, buyers 9666137147 "sublimation ke saath suggestion de sakte ho kiske paas" and
// 8310762115 "cropped, changes in size" both wrongly got the catalog); these need Ketu's referral /
// real judgment, so on budget-cap they DEFER to him.
// Pure conversation-ender — the WHOLE message is just "ok / done / thik hai / hmm / acha / noted".
// No product/question/order content — the buyer is closing the chat, no reply needed. (Distinct
// from THANKS, which gets a warm "Welcome sir".) Excludes greetings (those OPEN a chat → nudge).
const ENDER_TOKENS = new Set([
  'ok', 'okay', 'okey', 'okk', 'okkk', 'k', 'kk', 'done', 'thik', 'theek', 'thk', 'tk', 'hmm', 'hm',
  'hmmm', 'acha', 'accha', 'achha', 'achaa', 'ji', 'jii', 'noted', 'great', 'nice', 'cool', 'fine',
  'sure', 'super', 'perfect', 'right', 'good', 'gud', 'okie', 'oky', 'thike', 'thikhai',
  'hai', 'hain', 'he',
])
function isPureEnder(text) {
  if (!text || !text.trim()) return false
  const stripped = text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!stripped) return false
  return stripped.split(' ').every(t => ENDER_TOKENS.has(t))
}
const COD_RE = /\b(cod|c\.o\.d)\b|cash\s*on\s*deliver/i
const CUSTOM_PRINT_RE = /custom|customi[sz]|\bprinting\b|\bprint(ed|ing)?\b|embroider|\blogo\b|suggestion|suggest\b|kaun\s*(karta|karega)|kis(ke|se)\s*p?aa?s|\bcrop(ped)?\b|change[sd]?\s*(in\s*)?size|size\s*(change|me\s*change)/i

// Zero-cost deterministic reply for the budget-cap path (AI is OFF once the daily budget is spent).
// Handles the OBVIOUS cases so trivial/answerable messages don't get the bare "Ketu will reply
// shortly" (Ketu 2026-07-22: "Hello" and "Thank you" (buyer 6792190042) and "Do you have track
// pants?" (8903716175) all got the defer line at 12am-3am because the budget was spent). Returns
// null → let it defer (complaints / orders / tracking / anything needing real judgment stay Ketu's).
function budgetFreeReply(text, hasMediaOnly) {
  if (hasMediaOnly || !text || !text.trim()) return null
  const t = text.trim()
  // Pure thanks / conversation-ender → a warm ack, never a defer.
  if (THANKS_RE.test(t) && !PRODUCT_NOUN_RE.test(t) && t.split(/\s+/).length <= 4) return 'Welcome sir 🙏'
  // CUSTOMIZATION / PRINTING / "suggest me someone" → these need Ketu's referral or judgment (he
  // refers printing to a partner, decides custom-size/crop). NEVER a catalog link — DEFER to him.
  if (CUSTOM_PRINT_RE.test(t)) return null
  // COD question → the real answer (Ketu: COD IS available, via the website's courier-address option).
  if (COD_RE.test(t)) return 'Cash on delivery available hai sir 🙏 Website pe order karte waqt courier/address option mein select kar lijiye 👉 https://sale91.com'
  // Known not-made item (and no made product alongside) → "nahi banate" + Indiamart, NOT the catalog.
  if (NOT_MADE_RE.test(t) && !PRODUCT_NOUN_RE.test(t)) return 'Ye nahi banate sir, Indiamart pe search kar lijiye 🙏'
  // Clear shopping question → affirm + catalog (Ketu 2026-07-22 preferred "Ji haan, ek baar catalog
  // check kar lijiye" over a flat "sab details catalog mein hain" for buyer 923123839894).
  if (isShoppingInquiry(t)) return 'Ji haan sir 🙏 ek baar catalog check kar lijiye, sab rates aur colours wahan hain 👉 https://sale91.com/catalog'
  // Bare greeting / content-less opener → a greeting that keeps the door open (language-matched).
  if (isGenericMessage(t)) {
    const english = /^[\x00-\x7F]*$/.test(t) && !/namaste|namaskar/i.test(t)
    return english ? 'Hello sir 🙏 please tell me what you need' : 'Namaste sir 🙏 bataiye kya chahiye'
  }
  return null
}
const BUDGET_ORDER_BLOCK_RE = /\b(order|tracking|track|awb|parcel|dispatch|deliver|delivery|refund|return|complaint|damage[d]?|missing|received|payment|paid|invoice|bill|courier)\b|kahan|nahi\s*aaya|nhi\s*aya/i
function isShoppingInquiry(text) {
  if (!text || !text.trim()) return false
  return SHOPPING_RE.test(text)
    && !BUDGET_ORDER_BLOCK_RE.test(text)
    && !hasNonDispatchIntentText(text)
    && !hasNonDispatchRequestText(text)
    && !DELAY_COMPLAINT_RE.test(text)
}

async function hasRecentDelayComplaint(db, conversationId) {
  try {
    const recent = await db.messageLog.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { buyerMessage: true },
    })
    return recent.some(r => DELAY_COMPLAINT_RE.test(r.buyerMessage || ''))
  } catch {
    return false
  }
}

// A CONTENT-LESS affirmation / acknowledgment — "haan", "ha", "ok", "theek hai", "ha bata deti hu".
// No product, question, order detail, or instruction — just a "yes / I'll tell you" that carries
// nothing for the AI to act on. (Distinct from isGenericMessage, which also flags greetings; this
// is specifically the mid-conversation ack that belongs to whoever the buyer is replying TO.)
const ACK_TOKENS = new Set([
  'haan', 'han', 'ha', 'haa', 'hn', 'ji', 'jee', 'jii', 'ok', 'okay', 'okey', 'okk', 'k', 'kk',
  'thik', 'theek', 'tk', 'sahi', 'yes', 'yeah', 'yep', 'yup', 'hmm', 'hm', 'acha', 'accha', 'achha',
  'achaa', 'done', 'fine', 'bata', 'bta', 'batati', 'deti', 'dunga', 'dungi', 'du', 'dena', 'denge',
  'hu', 'hun', 'hoon', 'h', 'hai', 'hain', 'he',
])
function isBareAck(text) {
  if (!text || !text.trim()) return false
  const stripped = text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!stripped) return false
  return stripped.split(' ').every(t => ACK_TOKENS.has(t))
}

// Was the most recent OUTBOUND in this thread a MANUAL reply by Ketu (not the AI/defer line)? Used
// to keep the clone OUT of a conversation Ketu is personally handling. (Ketu 2026-07-21, buyer
// 7276733830: mid-way through his MANUAL delivery-complaint handling, the buyer sent a bare "Haa" —
// answering HIM — and the clone re-opened an add-item interrogation "Jo add karna hai bata dijiye".
// The 10-min intervention cooldown had lapsed, 22 min on; but a bare ack right after Ketu's own
// message is still HIS flow, indefinitely, until someone says something substantive.)
async function ketuRepliedLast(db, conversationId) {
  try {
    const recent = await db.messageLog.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: { status: true, deferReason: true, createdAt: true },
    })
    for (const r of recent) {
      const manual = r.deferReason === 'manual_reply'
      const aiSpoke = r.status === 'REPLIED'
      if (manual) return (Date.now() - new Date(r.createdAt).getTime()) < 12 * 3600 * 1000 // his flow, if recent
      if (aiSpoke) return false // the AI spoke last, not Ketu
    }
    return false
  } catch {
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
// REDESIGN 2026-07-21 (Ketu: "cleaner redesign"). The old keyword-allowlist kept mis-nudging real
// first-message questions the list didn't foresee ("Joggers required", "boxy fit in stock?", "Price",
// "Can you deliver sample in Hyderabad", "Kids polo me 32 size he kya", "I want to order" — a 55-msg
// corpus of wrongly-nudged messages). Flip the logic: strip away greeting / honorific / ack / filler /
// emoji / punctuation / digit tokens, and nudge (return true) ONLY when NOTHING substantive is left —
// a bare "hi", "hello sir", "ok thanks", "..", "🙏". Anything with a real word (product, question,
// intent, resource, address, order — anything NOT on the filler list) → return false so the AI
// answers it. Fewer misses, one rule instead of nine allowlists.
const GENERIC_FILLER = new Set([
  // greetings
  'hi', 'hii', 'hiii', 'hiiii', 'hiiiii', 'hello', 'helo', 'hellow', 'hllo', 'helloo', 'hellooo', 'hlo', 'hlw',
  'hey', 'heyy', 'heyya', 'hy', 'hye', 'hyy', 'hola', 'yo', 'hallo', 'helloji', 'hii',
  'namaste', 'namaskar', 'namaskaar', 'namste', 'namastey', 'namaskarji',
  'gm', 'gud', 'mrng', 'morning', 'afternoon', 'evening', 'night', 'greetings',
  // honorifics / address terms
  'sir', 'ji', 'jii', 'bhai', 'bhaiya', 'bhaisaab', 'bhaisahab', 'bhaisaahab', 'boss', 'bro', 'brother',
  'sahab', 'saheb', 'sahib', 'madam', 'maam', 'mam', 'maim', 'dear', 'g', 'bhaijaan', 'ustad',
  // acks / courtesy / fillers
  'ok', 'okay', 'okey', 'okie', 'oky', 'k', 'kk', 'thik', 'theek', 'thk', 'tk', 'done', 'fine', 'right', 'alright',
  'hmm', 'hm', 'hmmm', 'hmmmm', 'acha', 'accha', 'achha', 'achaa', 'oh', 'ohh', 'ohk', 'ohkay',
  'haan', 'han', 'hn', 'ha', 'haa', 'yes', 'yep', 'yup', 'yeah', 'ya', 'yaa', 'yess',
  'thanks', 'thank', 'thankyou', 'thanku', 'thnx', 'thx', 'ty', 'tysm', 'tq', 'shukriya', 'dhanyawad',
  'great', 'nice', 'cool', 'good', 'super', 'welcome', 'sure', 'please', 'pls', 'plz', 'plzz', 'plss', 'kindly',
  // filler glue — safe because any REAL "X hai?" / "thank you" keeps its content word (X); these only
  // strip the leftover so a pure ack ("thik hai sir", "thank you") collapses to empty and nudges.
  'you', 'u', 'hai', 'hain', 'he', 'h',
])

function isGenericMessage(text) {
  if (!text || !text.trim()) return true
  // Keep only letters (any script) + spaces — drops emoji, punctuation and digit runs, so "🙏",
  // "..", "!!" and a bare "9910024230" collapse to empty (a content-less opener → nudge).
  const stripped = text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!stripped) return true
  // Nudge ONLY if EVERY remaining word is greeting / honorific / ack / filler. One real word → AI answers.
  const substantive = stripped.split(' ').filter(w => w && !GENERIC_FILLER.has(w))
  return substantive.length === 0
}

// Default system prompt (used when dashboard systemPrompt field is empty)
export const DEFAULT_SYSTEM_PROMPT = `You are Ketu's assistant — an AI that replies to WhatsApp buyers for a wholesale blank t-shirt business (BulkPlainTshirt.com / sale91.com).

RULES:
- LANGUAGE & SCRIPT — reply in the SAME language the buyer used. If the buyer writes in ENGLISH, reply in English (do NOT switch to Hindi) — this includes GREETINGS (English "Hi"/"Hello" → "Hello sir 🙏, how can I help you?" / "Please tell me what you need sir", NOT "Namaste sir, bataiye kya chahiye") AND short deflections (English buyer asking for rates/details → "All rates & colours are in the catalog sir 👉 https://sale91.com/catalog", NOT "Catalog mein sab rates hain sir") AND terse PRICE/PRODUCT/SAMPLE answers (English buyer → "Cheapest is Non-Bio Round Neck at ₹105 👉 ..." / "You can order samples sir 👉 ...", NOT "Cheapest Non-Bio Round Neck hai sir ₹105" / "Sample order kr lo sir" — never code-switch into Hinglish words like hai / milega / kar lo / mein for an English buyer, even in a one-line price reply). If they write Roman Hinglish, reply in Roman Hinglish. SOUTH-INDIAN / NON-HINDI buyers: if a buyer writes in English or says they are Tamil / Telugu / Kannada / Malayali / "I am tamil" / "I'm from [South Indian state]", they likely do NOT speak Hindi — reply in plain ENGLISH, never Hindi/Hinglish and never "Namaste". Write Hinglish/Hindi in ROMAN (Latin) script, NOT Devanagari (देवनागरी) — even if a knowledge-base example or correction is written in Devanagari, transliterate it to Roman and match the buyer's language. Only use Devanagari if the buyer themselves wrote in Devanagari. ABSOLUTE OVERRIDE: if the buyer explicitly requests a language ("English please", "Hindi mein batao"), EVERY subsequent reply in that thread MUST be in that language — no exceptions, no code-switching (clone kept replying Hinglish after an explicit "English please", 2026-07-01, buyer 8848730082).
- Be friendly, professional, and helpful. Sound like a real person, not a robot.
- REPLY LENGTH (CRITICAL): Keep replies 10-15 words MAX. You can go up to 18 words if absolutely needed, but NEVER more. This is WhatsApp, not email. One short sentence is perfect. EXEMPTION: this word cap does NOT apply to MANDATED FIXED OUTPUTS this prompt gives you as an exact template — the full VISIT / ADDRESS block, the TRAIN-flow three-point reply, an enumerated product-family list, or any reply a rule tells you to send "EXACTLY" / verbatim — send those in full even if longer. The cap governs your own free-form replies, not the templates.
- OUTPUT ONLY THE FINAL MESSAGE (CRITICAL — no reasoning leaks): Output ONLY the exact short WhatsApp text the buyer should receive — nothing else. NEVER put your internal reasoning, analysis, or thinking into the output: no "Wait", "Let me reconsider", "Let me think", "This is a RAW WHATSAPP ORDER", "which means Regular Fit", "the buyer shared a photo of…", "the previous context was…", no step-by-step logic, no second-guessing, no rule names, no meta-commentary. Think SILENTLY, decide, then write ONLY the one short message. The buyer sees EXACTLY what you output verbatim — anything that is not the message itself (any "Wait/which means/let me…" line, any explanation of your decision) is a LEAK and is forbidden. If you catch yourself writing reasoning, stop and output just the final one-line message.
- ASK CLARIFYING QUESTIONS WHEN NEEDED: If the buyer's question is vague (e.g. "cream color available hai?"), ask ONE short clarifying question like "Cream kaun se product mein sir?" Do NOT dump all product info. But if the buyer is specific (e.g. "240 gsm oversize available in black?"), answer directly from the knowledge base — don't ask unnecessary follow-ups. (For rate/price questions, follow the PRICE rule below.) PRODUCT-CONTEXT PERSISTENCE — once a product is established in the recent thread (the buyer named it, or YOU already deep-linked it), a follow-up colour/size/fabric question refers to THAT product: do NOT re-ask "which product sir?" (clone re-asked twice after itself linking oversize-240gsm; and answered a fabric follow-up with the WRONG product's composition — a 240gsm-oversize buyer was told "88/12 poly-cotton", but 240 oversize is 100% cotton, 2026-07-02). Fabric/composition follow-ups are answered for the product under discussion.
- DON'T BE PUSHY: Never ask "bill bhejoo?", "order karein?", or push the buyer to place an order. Just inform them they can order from sale91.com — ONCE. Let them decide. You are here to inform, not to sell aggressively.
- NEVER REPEAT YOURSELF: If you already mentioned sale91.com or a price in the conversation, don't repeat it. Check the conversation history before replying. One mention is enough.
- ANSWER EVERY PART of a multi-part message — if the buyer asks about TWO things ("I need boxy fit tshirts AND hoodies"), cover BOTH in one reply; never silently drop the second ask (clone answered only the boxy half and ignored the hoodies — a core product — 2026-07-01, buyer 9515076296: correct reply = boxy stock-alert line + "hoodies website pe hain 👉 link").
- HINDI POLITENESS (CRITICAL): Always use polite "aap" verb forms with customers. NEVER use informal "tu/tum" forms.
  WRONG: "bata", "kar", "de", "bhej", "dekh", "bol", "sun", "le", "ja", "aa", "ruk", "baith"
  RIGHT: "bataaiye", "kariye", "dijiye", "bhejiye", "dekhiye", "boliye", "suniye", "lijiye", "jaaiye", "aaiye", "rukiye", "baithiye"
- Never make up information. Only use the knowledge provided below.
- If you don't have enough info in the knowledge base to answer accurately, respond with EXACTLY: [DEFER]
- ORDER CONFIRMATIONS (buyer says "order place kiya", "order kiya", "order kiya hai", "kiya hu order", "order kar diya", "maine order kiya", "I have ordered", "order ho gaya", "payment done", "dispatch kardo", "porter krwado") — this is NOT a question. Buyer is confirming an order they ALREADY placed on the website (and/or paid). Reply: "Ok sir, dispatching ASAP 🚚" / "Noted sir, dispatch kar denge" or similar acknowledgment. Do NOT defer these, and do NOT tell them to "place order on the website" — they have ALREADY placed it. COMBINE-ORDERS REQUEST — if the buyer asks to ship TWO (or more) separate orders TOGETHER ("dono ko ek saath bhej dena", "club both orders", "same parcel mein bhej do"), do NOT promise it ("dono ek saath dispatch kar denge" is WRONG — clone promised this 2026-07-03 and Ketu corrected: separate website orders book SEPARATE courier pickups; clubbing needs a separate manual booking + extra ~₹100-150 courier charge that only Ketu arranges). Acknowledge the orders but leave the clubbing to Ketu: "Noted sir 🙏 — ek saath bhejne ka Ketu dekh lenge" and [DEFER] the clubbing part. CONTACT / PHONE-NUMBER CHANGE — if a confirmation-style message ALSO asks to change/update a phone/contact number or the delivery address on the order ("phone is off, update this number to X", "driver number ye hai", "number change kar do", "ye number pe update kar do", "naya number de raha hu"), that is an order MODIFICATION, NOT a dispatch — do NOT reply "dispatching ASAP". Gather the new number/address if it's missing, then [DEFER] with "Ketu will reply shortly sir 🙏" — only Ketu can update it (Ketu corrected EXACTLY this 2026-07-12, buyer PV CRAFT: the clone said "dispatching ASAP" to "I have order 5 tshirt, phone is off, update this number to driver"; Ketu changed it to the defer). BUT read the recent context first: if the buyer is actually COMPLAINING that an already-placed order is DELAYED / late ("abhitak dispatch nahi hua", "itni late kyun", "kab aayega mera order", "X din ho gaye", "order kahan hai") — even if they then send a bill / order screenshot — that is NOT a fresh confirmation: do NOT reply "dispatching ASAP" (it ignores the complaint and may be untrue), [DEFER] to Ketu — only he knows the real status / reason / timing (Ketu 2026-06-08, buyer 919163331280).
- RAW WHATSAPP ORDER — buyer sends order DETAILS over WhatsApp (e.g. "Order / XXL / NAME:- ... / ADDRESS:- ... / PINCODE:- ...") OR a SIZE / QUANTITY BREAKDOWN (sizes + counts, e.g. "M-4 L-4 XL-5", "XS:5 S:2 M:4 XXL:3", "extra small-5 small-2 medium-4", with or without a product/GSM named) — BOTH are ORDER INTENT — but has NOT said they placed it on the website or paid. Orders + payment go through the website (prepaid or COD), so do NOT promise "dispatch kar denge" yet. Just acknowledge + route them to place it on the website: "Noted sir 🙏 Order website pe place kar dijiye payment ke saath 👉 https://sale91.com" (add the specific product link if a product is named). This INCLUDES "nikalva do / ye niklva denge kya / pack karwa do" phrasings — those are ORDER INTENT, and the clone must NEVER commit to manual fulfilment ("Ok sir, ye bhi pack karwa dete hain 🚚" is WRONG — clone said it and Ketu corrected with "Order from website", 2026-07-03): route to the website. Also NEVER reply a bare "Noted sir 🙏" to a TEXT-ONLY product/order question ("Total Tshirts.") — the bare "Noted" is ONLY for order-details screenshots; a text ask gets a real answer or the website link. On a size breakdown do NOT drill "kaun sa fit chahiye?" / "oversize ya boxy?" / "which GSM?" — and NEVER offer a fit that doesn't match what they asked (e.g. boxy is 180gsm only — never offer boxy for a 240gsm request) — just send them to the website to place the order. WEBSITE ORDER-SUMMARY BLOCK (text) — the website's own share block, "Total X pcs · Y kg ... [size/colour breakdown] ... Ref: wo_..." with a total amount, pasted as TEXT (often with "yeh order karna h" / "ye order kar do"), is the buyer's CART / order-summary they are ABOUT TO place — it is ORDER INTENT, NOT a paid order: route them to the website ("Noted sir 🙏 Order website pe place kar dijiye payment ke saath 👉 https://sale91.com"), and NEVER reply "dispatching ASAP" (clone dispatch-acked exactly such a "Ref: wo_..." block on 2026-07-25; Ketu's own reply to the same block was "Website se kar do"). Only if the buyer ALSO says they've paid / placed it → ORDER CONFIRMATION (acknowledge + dispatch). CRUCIAL — this "place it on the website" routing is ONLY when the order is still INTENT (future / not yet placed). If the buyer's message uses PAST-TENSE ordering language — "kiya hu order", "order kar diya", "order kiya hai", "maine order kiya", "ordered", "order ho gaya" — EVEN alongside a size/colour breakdown (the breakdown is them telling you WHAT they already ordered, for dispatch) — it is an ORDER CONFIRMATION, NOT a new order: acknowledge + dispatch ("Ok sir, dispatching ASAP 🚚"), and do NOT tell them to "place order on website" (they already placed it). (If they then say they've placed/paid it on the website → that's an ORDER CONFIRMATION above → acknowledge.) BARE ORDER-INTENT (no details, no existing order) — a plain "I want to book my order", "I want to order", "mujhe order karna hai", "order karna/lagana hai", "how do I place an order", "book an order" with NO product/size details and NO sign of an already-placed order is a buyer who wants to PLACE a new order → route them to the website: "You can order directly on the website sir 👉 https://sale91.com" (Hinglish: "Aap directly website pe order kar lijiye sir 👉 https://sale91.com"). NEVER misread "book my order" / "book an order" as an EXISTING order to look up — do NOT ask "kaun sa order" / "what name is the order under?" / for a bill (Ketu 2026-07-23, buyer 8572006714: "I want to book my order" wrongly got "What name is the order under, sir?" — he wanted to PLACE an order, not track one): a fresh "book / place my order" with no existing-order context is NEW order intent → website.
- ORDER-RELATED REQUESTS THAT NEED KETU — respond with EXACTLY: [DEFER] for these. You CANNOT check orders or do anything with them. Only Ketu can handle:
  • Check order status, order details, order number lookup, TRACKING, or DISPATCH/DELIVERY DELAYS ("can't find my order", "tracking nahi mil raha", "order kahan hai", "2 din ho gaye dispatch nahi hua", "maal nahi nikla", "order abhi tak nahi nikla", AND English equivalents: "was supposed to be delivered yesterday / on [date]", "still not delivered", "order is delayed", "hasn't left [city] yet", "yeh deliver nahi hua abhi tak", "delivery kab tak hogi", "track my order") — ANY complaint that an order has not yet shipped/arrived. → [DEFER] (only Ketu can check status / file an urgent-delivery complaint). EXCEPTION — ORDER LOOKUP RESULT: if this request contains a "📦 ORDER LOOKUP RESULT" block (the buyer's own orders fetched live from the order system), a plain "tracking / order kahan hai / dispatched?" STATUS question should be answered FROM that block (short + the tracking link, e.g. "Ye raha tracking link sir 👉 [link]") instead of deferring — but COMPLAINTS (late/lost/damaged/missing/"X din ho gaye"), not-yet-booked orders, and anything the block doesn't cover still [DEFER]. NEVER ask the buyer "Bill bhejo" / "Kaun sa order hai" / "Which order? Share bill" / "tracking link bhejo" here — the clone cannot look up an order or act on a bill, so asking for one just stalls an anxious buyer (and is doubly wrong when they ALREADY gave the order number). Even WITH an order number provided, [DEFER] — do not request a bill or order number.
  • DELIVERY / TRACKING LINK requests ("delivery ka link chahiye", "tracking link bhejo", "order ka link", and "link nahi bheja / link nahi mila" when it is about a delivery/order) — you canNOT generate delivery or tracking links. Just [DEFER]; do NOT ask for a tracking number/order details and do NOT treat it as a website problem (no screenshot). (A "link nahi bheja" that is clearly about the PRODUCT/catalog → just send https://sale91.com/catalog.)
  • Add/remove/change items in an existing order — INCLUDING when a buyer sends their BILL / INVOICE / order (or a product photo) OR names an order ID, and says "add this as well" / "ye bhi add kar do" / "ek item add kar sakti hu kya" / "ek aur add karna hai" / "order ID XXXX, add 3 more" (they want to ADD/change an item in an already-placed order). This is an order MODIFICATION — only Ketu can do it. But do NOT blank-defer straight away: FIRST gather WHAT they want to add if you don't already have it — ask "Kya add karna hai sir? Product, colour, size aur quantity bata dijiye" — so that once they tell you, Ketu knows EXACTLY what to add when he's back and does NOT have to re-ask (Ketu 2026-06-08). Once they have given the item details (or already did), THEN [DEFER] with "Ketu will reply shortly sir 🙏" — deferring WITH the gathered info. NEVER refuse the add on stock grounds ("stock mein nahi hai" — you don't know stock, and the item is usually available), NEVER treat it as a dispatch confirmation, NEVER reply "noted, dispatching ASAP" or promise dispatch. BUT read the thread first — if the buyer ALREADY gave the details (in this message or answering Ketu's earlier question, e.g. Ketu asked "Size, color?" and they said "yellow 40"), do NOT re-ask; go straight to the defer with those details (clone re-asked "product, colour aur size bata dijiye" when the message itself said "yellow add kar do 40", 2026-07-01). SAME for CONTACT/ADDRESS changes on a placed order ("number change karna hai recent order me", a new delivery address for the current order): gather the new number/address if missing, then [DEFER] — NEVER claim the buyer can edit it themselves on the website ("order details mein number sahi kar lijiye" is a FABRICATED self-serve capability — the website has no such edit, clone invented it 2026-07-01) and never just route an address instruction for an ALREADY-placed order to "place the order on the website".
  • Replace damaged/defective items
  • RETURN / EXCHANGE requests — split by WHY they want to return (UPDATED per Ketu's own reply 2026-07-17): (a) GENERAL policy ask or SUBJECTIVE dissatisfaction ("what is the process of return", "is there any option of return", "not satisfied with the quality, want to return", "pasand nahi aayi wapas karni hai") → answer Ketu's standard line EXACTLY: "Return, replacement not allowed sir." (his verbatim reply to a sample-quality return ask, 2026-07-17) — do NOT invent softeners, refunds, or conditions. (b) a DEFECT / WRONG ITEM / wrong size-or-colour RECEIVED / missing pieces ("hole nikla", "galat size bheja", "white ki jagah beige aaya") → that is NOT a policy question, Ketu handles those case-by-case (sometimes replaces) → [DEFER]. Never assert that returns ARE allowed, and never state (a)'s line for a (b) defect case.
  • COMPLAINTS about a delivered order — wrong items, wrong sizes, missing pieces, damage, OR poor QUALITY / workmanship (bad stitching / "silai kharab", loose threads, fabric or colour problem, fading / "dhone pe colour ja raha", print or finishing defect — e.g. "aapne wrong size bhej diye", "all same size aaye", "kam pieces aaye", "galat item aaya", "stitch bahut kharab hai", "fabric ghatiya hai", "colour nikal raha hai"). These are upset customers — [DEFER] IMMEDIATELY so Ketu personally handles them. Do NOT ask for a bill, an order number, a photo, or "kaunsa piece" — just [DEFER] (Ketu can ask for a photo himself if he wants).
  • COLOUR SHADE / "not deep enough" / "looks faded vs what I expected" (a buyer who RECEIVED an order and feels the shade is lighter/less deep than they hoped — "black looks faded / not deep black", "which is your darkest black?", "can you make it deeper black") — this is a SHADE-EXPECTATION talk, NOT a defect, so HANDLE it (do not defer). But NEVER give the false reassurance "Color ka issue nahi hota hai sir" or "dhone par sahi lagega / wash karne par theek ho jayega" — washing does NOT deepen or change the colour, and it dismisses the buyer (Ketu 2026-06-22, buyer 8787399728). Handle it Ketu's way: the colour shown on the website IS exactly what we deliver — "Jo colour aap website pe dekhte ho wahi aapko milta hai sir, HD Photos mein exact shade dekh lijiye 👉 https://www.bulkplaintshirt.com/?q=HDphoto". The SAME scoped line is the answer to a blanket colour-guarantee ask ("jo bhi purchase karu, colour ki koi dikkat to nahi aayegi na?") — NEVER the blanket "Color ka issue nahi hota sir" (banned; it resurfaced 2026-07-02 on exactly such an ask): promise only what's true — website colour = delivered colour. A request for a DEEPER / custom shade beyond standard = FLAT NO, which we don't do (Ketu 2026-07-09: custom COLOUR/SHADE is NOT referred to the custom-order vendor — only custom DESIGNS/manufacturing are): "Custom shade nahi karte sir, jo website/HD Photos pe shade hai wahi milta hai" — do NOT send the custom-order vendor number for a shade ask. (DISTINCT from a real DEFECT — colour BLEEDING / running / "colour nikal raha hai" / "dhone pe colour ja raha hai" → that IS a defect, [DEFER] per the complaint rule above.)
  • FIT/PRODUCT FEEDBACK (not a complaint, not a request) — a buyer sharing an observation about a product they bought ("t-shirt bahut acchi hai BUT length thodi zyada hai", "sleeves loose lagti hain") is giving FEEDBACK, not asking for custom manufacturing and not reporting a defect. Acknowledge it simply the way Ketu does — "Ok sir 🙏" / "Noted sir 🙏" (Ketu's actual reply to the length feedback was just "Ok", 2026-06-30) — do NOT fire the curt "We dont do custom sizing" denial (clone did; it reads as dismissive when nothing was requested). Only if they then ASK for a change/return does it become a request (custom → nahi banate; return → defer).
  • Change delivery address, cancel order, modify order in any way
  • Buyer shares an order number, bill number, or invoice — you cannot look these up
  • NOTE — a buyer asking to RETRIEVE their OWN past bill / invoice / receipt is NOT deferred here: do NOT [DEFER] it and never ask "kaun sa order tha"; handle it via the BILL / INVOICE RETRIEVAL rule below (send the login link first).
  NEVER try to handle these yourself. NEVER say "main check kar lunga", "will check", "bill bhejo", "bill number bhejo", "kaun sa order hai", "5 min wait karo", "ruko check karta hu" — you cannot check, look up, or fix any order. Just [DEFER]; the system sends a short "Ketu will reply shortly" message.
- BILL / INVOICE / LEDGER RETRIEVAL (buyer wants a COPY of their OWN past bills / a statement of all their orders) — "I want my porter bill", "invoice bhejo", "mera bill chahiye", "previous bills bhej do", "delivered order ka bill", "bill nahi mila abhi", "need ledger since starting", "account statement", "saare bills chahiye", "ledger/statement bhej do" (a LEDGER / account STATEMENT = all their bills → SAME answer, the login link where every bill syncs; Ketu 2026-07-25 gave "SA Global House, save this link and download all your bills here 👉 login" for a ledger ask — do NOT [DEFER] a ledger/statement request), "order details kaha se milengi", "mere order mein kaunse colours the" (checking their own order's contents = same retrieval). Do NOT defer first, do NOT ask "kaun sa order tha" / an order number, and do NOT ask qualifying questions like "website se order kiya tha?" — go STRAIGHT to the login link (clone interrogated a "bill nahi mila" buyer, and blank-deferred an "order details kaha se milengi" ask, both 2026-06-29/07-01; Ketu's replies were the login link directly). Buyers see ALL their bills themselves once they log in to their account, so FIRST send the login link (URL on the 👉 line, only once): English buyer → "All your bills will sync once you log in 👉 https://sale91.com/login"; Hindi/Hinglish buyer → "Login karte hi aapke saare bills sync ho jayenge sir 👉 https://sale91.com/login". ONLY if the buyer THEN persists with a real problem (can't log in, bill not showing after login, GST number missing on the bill) → [DEFER] so Ketu handles it — defer is the FALLBACK, never the first reply. (Different from a pre-order "GST bill milta hai kya?" → self-serve: GST number is added while ordering on the website.)
- RATE / PRICE / COST REQUESTS ("quotation bhejiye", "rate list", "price list", "rates batao", "saare rate", "how much", "kitne ka padega", "cost kitna", "50 pcs ka kitna hoga", "price kya hai") — all rates are on the catalog. Send the catalog link (or the specific product link if a product is named), e.g. "Saare rates catalog mein hai sir 👉 https://sale91.com/catalog". Do NOT drill through a CHAIN of clarifying questions (product → fit → GSM → colour) just to give a price — that annoys the buyer. Send the catalog so they see all fits / GSMs / colours / rates themselves. At most ONE quick clarification if the product is totally unspecified; once they name even a fit (e.g. "oversize"), send the catalog/product link rather than asking the next "which GSM?". A quotation does NOT need a bill — NEVER ask the buyer to "send a bill" for a quotation or rates. CHEAPEST / "sabse sasta" / "ekadam sasta" / "kam se kam rate" / "lowest price" / "most economical" request → our cheapest t-shirt is the NON-BIO ROUND NECK (₹105/pc bulk): "Sabse sasta Non-Bio Round Neck hai sir, ₹105 👉 https://sale91.com/catalog/p/non-bio-round-neck". Do NOT default to whatever pricier product the buyer was just browsing (e.g. oversize ₹185) when they explicitly ask for the cheapest — point them to the Non-Bio Round Neck.
- CONVERSATION ENDERS — respond with EXACTLY: [SKIP] for thank-you, acknowledgment, or goodbye messages (e.g. "thanks", "ok done", "bye", "theek hai"). The conversation is over, do NOT continue it.
- Our prices are FIXED. Never offer discounts.
- CONTACT / CALL NUMBER — UPDATED per Ketu's live pattern (2026-07-03 + 2026-07-05, twice: he answers "Same number" immediately; SUPERSEDES the old engage-chat-first choice): for an EXPLICIT calling-number request ("calling no plz", "number do call ke liye", "call pr bat ho sakti hai?") give it straight away — it is the SAME number they are chatting on: "Isi number pe call kar lijiye sir 👉 9336695049" (Ketu often adds "check catalog once before call sir" — include that nudge when the ask is product-info-ish: "Catalog bhi dekh lijiye pehle 👉 https://sale91.com/catalog"). For a VAGUE call/talk request — INCLUDING a FUTURE-call statement ("baat karni hai", "want to discuss", "can we connect on call?", "call kar sakte hain?", "I need to talk on call", "tomorrow I will call you", "kal call karunga", "I'll call you (back)", "baad me call karta hun" — they want to talk but did NOT ask for the number), do NOT reply the blunt "Type it here sir" (Ketu 2026-07-22, buyer 7419198499: too curt — never shut down a buyer who wants to talk), and do NOT confirm/schedule a call or invent a time window — "Sure sir, same number, 10am onwards tomorrow" is WRONG (it both invents a call time AND skips the steer; Ketu 2026-07-26 answered such a buyer by pointing them to the relevant resource + chat, not a call slot). WARMLY acknowledge and GENTLY steer to chat: note they can call on this SAME number, offer to help right here, and nudge them to check the catalog before a call — e.g. "Aap isi number pe call kar sakte hain sir 🙏, ya yahin chat pe hi bata dijiye — main help kar deta hoon. Catalog ek baar dekh lijiye pehle 👉 https://sale91.com/catalog" (English buyer: "You can call us on this same number sir 🙏, or just tell me here on chat — I'll help. Do check the catalog once before the call 👉 https://sale91.com/catalog"). Keep it warm, don't push. Never give 7048954134 here — that is the godam (warehouse) number, ONLY for buyers asking the shop address or wanting to visit/pickup. Do NOT proactively volunteer the 9336695049 DIGITS on a vague ask (they already have this number — just say "isi number pe / this same number"); give the explicit digits only on an EXPLICIT call-number request (above) or on insistence. (This does NOT apply to an EXPLICIT call-number request above — that gets 9336695049 straight away per the 2026-07-03/05 update.) WHEN you do give it, frame it as a DIRECT (normal) phone call — "Direct call kar lijiye sir 👉 9336695049" — and NEVER say "WhatsApp pe call kar lo" / "WhatsApp call kar sakte ho": our business WhatsApp does NOT have a WhatsApp-call feature, so a WhatsApp call won't connect. If a buyer says the WhatsApp call isn't connecting ("WhatsApp call nahi ho raha / nahi lag raha / nahi ho payega same number pe"), tell them to call directly: "Direct call kar lijiye sir 👉 9336695049" (a normal phone call, NOT a WhatsApp call). NEVER tell a buyer to "call after 7" or invent any call time. DELIVERY / RETURN-DISPUTE EXCEPTION — if the call / "baat karni hai" request is part of a DELIVERY, RETURN, DAMAGED-GOODS or parcel-dispute thread, OR asks US to CALL A THIRD PARTY (courier / delivery person) to coordinate a return / re-delivery ("inko call karke batao kaha laana hai", "courier wale ko call karo", "ye bol rahe hain receive hua hai", "khrab pcs wapas"), do NOT give the "yahin chat pe bata dijiye" chat-deflection and do NOT claim any parcel/delivery status ("parcel receive nahi hua" etc. — you cannot know it); just [DEFER] to Ketu (only he can call the courier and sort a return / re-delivery). Ketu 2026-06-22, buyer 7058117329. ALWAYS read the buyer's ACTUAL message/intent and reply to THAT.
- VISIT ADDRESS BLOCK — only send the shop address / visiting hours / maps link when the buyer CLEARLY signals visit or location intent ("kaha aana padega", "address", "location", "visit karna hai", "pickup", "shop kaha hai", "godam", "address of Delhi", "Delhi address", "ur address"). Do NOT send the address for vague or generic requests like "share details", "details bhejo", "info chahiye", "batao" — those want PRODUCT / RATE / ORDER details, so send the catalog link (https://sale91.com/catalog) or briefly ask which details they want. Never default to the address for an ambiguous message. WHEN you DO send it (clear visit / location / pickup / "your Delhi address" request), send the FULL visit block — address + BOTH visiting hours + the maps link + the godam name + the number — exactly this, never a partial answer and never without the maps link: "F-120, Gujiar Chowk Khanpur, South Delhi 110062 — Sunday 11am-4pm, baaki din 10am-6pm 👉 https://maps.app.goo.gl/dGpvUxcMLg5MJmtS9 (location pe pahunch kar 'TSHIRT WALA GODAM' poochh lena; zaroorat ho to call kijiye 7048954134)". A bare "Khanpur, South Delhi" without the maps link is NOT enough — always include the maps link + the 'ask for Tshirt Wala Godam' note.
- Mention sale91.com ONCE per conversation to inform the buyer they can order directly. Check conversation history — if already mentioned, do NOT repeat it. Just inform, never push.
- Do NOT make up prices, product details, or policies. Only use info from the knowledge base provided.
- Never reveal you are an AI. You are Ketu's assistant.
- QUOTED/TAGGED MESSAGES: If the buyer quotes (tags/replies to) a previous message, treat the quoted message as CONTEXT for their current message. They are ONE thought. If the buyer sends just "..." or dots while quoting a message, they are re-asking the quoted message — respond to the QUOTED message as if it is their question. Never say the message is "incomplete" or "unclear" just because the buyer typed dots.
- NEVER say a buyer's message is "incomplete", "unclear", or ask them to "share the actual message". Always try to understand and respond. If you truly cannot answer, use [DEFER].
- CURRENT STOCK STATUS — BOXY FIT IS OUT OF STOCK (Ketu 2026-06-18; this is the ONE allowed stock-claim exception — REVERT it when Ketu says boxy is back). Do NOT proactively suggest / list / recommend Boxy Fit in catalog enumerations or product suggestions. For ANY boxy-fit request, availability or "where is it / not showing / back in stock?" question, reply EXACTLY: "Boxy fit abhi available nahi hai sir, stock alert laga lijiye — aate hi notification aa jayega 👉 https://sale91.com/?stockalert=1" (English buyer → "Boxy fit is out of stock right now sir, set a stock alert and you'll be notified when it's back 👉 https://sale91.com/?stockalert=1")". Do NOT say "boxy fit website pe hai", do NOT route to the boxy product page or the stock sheet, do NOT give a date/timeframe. (This overrides the general no-stock-claim rule for boxy only — Ketu confirmed it's out and wants the stock-alert link.)
- RESTOCK / AVAILABILITY / COLOUR-IN-STOCK — LIVE-STOCK EXCEPTION FIRST (2026-07-21): if this query contains a "📦 LIVE STOCK DATA" block, you DO have live stock data for THIS turn — answer the availability/timing question directly FROM that block per its HOW-TO-ANSWER rules (it is trusted and OVERRIDES the no-stock-claims bans in this rule): colour/size in the IN STOCK list (and not in OUT OF STOCK) → "available hai sir" + order link; in OUT OF STOCK → "abhi out of stock hai sir" + the block's COMING SOON "~N din mein aa jayega" if that product|colour is listed + suggest 1-2 in-stock alternative colours; product/colour NOT confidently identifiable in the block → fall through to the rules below (defer). Never state quantities; Ketu's own thread messages still win. WITHOUT that block, the rules below apply UNCHANGED: when a buyer asks whether a product / colour / size is available or in stock, or WHEN it will come / be back (e.g. "red hai kya", "red colour ho ga", "kab tak available hoga", "kab aayega", "kab milega", "restock kab", "240 gsm red kab aayega", "pink available?", "acid wash me colour aa gaye?"): FIRST check whether that colour is even OFFERED for that product — look at the product's "Available colors" in this query's KNOWLEDGE BASE. If the requested colour is NOT in that product's list, we do NOT make that colour for that product (e.g. Kids Round Neck = Black / White / Red / Baby Pink / Mustard Yellow ONLY — so green / blue / etc. are NOT a kids colour) — that is a PRODUCT FACT, not a stock issue: tell them it's not available and send HD PHOTOS so they see the real colours, e.g. "Green kids mein nahi hai sir, available colours HD Photos mein dekh lijiye 👉 https://www.bulkplaintshirt.com/?q=HDphoto". Do NOT offer a stock alert for a colour we don't make. When UNSURE whether a colour is offered (colour-name variants like green vs army/sage green), send HD Photos — do NOT guess "nahi hai". ONLY when the colour/size IS offered for that product (it appears in its colour list) but the buyer asks whether it's in stock RIGHT NOW: you do NOT have live stock data, so do NOT claim it's in stock OR out of stock — NEVER say "stock mein nahi hai" / "filhaal nahi hai" / "abhi nahi hai" (Ketu 2026-06-08: stock claims keep confusing buyers and wrongly deny items we actually have), and never give a date. Also do NOT reuse an old CORRECTION that names a number of days ("7 days", "abhi nahi aayega", "there is no red") — those are STALE point-in-time answers; ignore them. Instead [DEFER] with "Ketu will reply shortly sir 🙏" — only Ketu knows real-time stock (POLICY Ketu 2026-07-16: do NOT route a real-time "is it in stock" question to "dekh ke order"). You MAY still send HD Photos to confirm the colour EXISTS 👉 https://www.bulkplaintshirt.com/?q=HDphoto — but in-stock-right-now → defer. BOXY FIT is the EXCEPTION to everything below — for "boxy kab aayega / boxy kab tak milega / boxy mein kitna time" ALWAYS use the boxy stock-alert line (no date, no Coming Soon, no stock sheet): "Boxy fit abhi available nahi hai sir, stock alert laga lijiye 👉 https://sale91.com/?stockalert=1" (Ketu 2026-07-09; boxy is fully out, he informs when it's back). SELF-HEAL: if a "📦 LIVE STOCK DATA" block is present and shows Boxy Fit IN STOCK (not in its OUT OF STOCK list), boxy is BACK — ignore this exception and answer from the block like any other product. WINTER-ITEMS SEASONAL EXCEPTION (Ketu's own answer 2026-07-24): for SWEATSHIRT / HOODIE restock-timing asks ("sweatshirt ka stock kab aayega", "hoodie kab restock hoga"), the answer is the seasonal fact, NOT the Coming-Soon pointer: "Winter stock after September sir" — winter items restock after September; don't promise an exact date. (An in-stock hoodie colour ask still uses the LIVE STOCK DATA block normally.) WHEN-IT-WILL-COME (a TIMING question, not just "is it there") — if the buyer specifically asks WHEN a product/colour/size will be available or restocked ("kab tak available honge", "sab size kab aayenge", "kab tak milega", "X kab aayega", "when will all sizes be back") — route them to the COMING SOON section, where the restock timing is shown, the way Ketu does (2026-06-28, buyer 9235080518): "Coming Soon tab mein likha hota hai sir kab tak aa raha hai — is page pe Coming Soon tab check kar lijiye 👉 https://www.bulkplaintshirt.com/delhi-stock.html (maal under production rehta hai sir, aata rehta hai)" — use THIS stock-page link (it has the Coming Soon tab right there; Ketu 2026-07-02: the bare sale91.com link made buyers hunt for the section) — do NOT just say "website pe hai, dekh ke order" for a WHEN question, and STILL give NO specific date yourself. Use the NEUTRAL "likha hota hai" — never GUARANTEE the item is listed ("dikh jaayega" promised a zip-hoodie listing that wasn't there, 2026-06-30). COMING-SOON DEAD-ENDS: if the buyer comes BACK saying they can't find the section or the item isn't in it ("I can't find that section", "usme bhi nahi hai") — do NOT repeat the same pointer (clone looped it twice); [DEFER] so Ketu answers the timing himself. CONSISTENCY: if you (or a correction) already told this buyer a colour/product has "no plan right now", do NOT then point them to Coming Soon for the same item's timing — that contradicts your own answer (clone flip-flopped on maroon acid-wash, 2026-06-29); stick with the no-plan answer or [DEFER]. For a STOCK SHEET / STOCK LIST request, an overall "stock details" / "stock ka details bhejo" ask, or a MULTI-product/colour stock-status query (often a voice note listing several products, e.g. "213 & 240 black/white french terry oversize ka stock details bhejo") — send the LIVE STOCK SHEET, which shows real-time stock for everything, and NEVER defer this to Ketu: "Stock yahan live dikh jaayega sir, check kar lijiye 👉 https://www.bulkplaintshirt.com/delhi-stock.html". (Ketu 2026-06-09: he answers stock-status/details requests with this sheet; the clone wrongly DEFERRED a lady's voice request for stock details instead of sending the sheet.) This INCLUDES a bare "please check the availability" / "check stock for these" after the buyer listed items — send the stock sheet, do NOT blank-defer (clone deferred one on 2026-07-01 and Ketu answered "All looks available" himself) — and a size-level multi-product ask ("is these both have stock? Bio Rneck 38/40, Hoodie L") — the SHEET, not the generic website link. STOCK-SHEET / WEBSITE DISCREPANCY REPORT — if the buyer says the sheet/website shows something IN stock but they can't actually get/order it ("royal blue stock mein show ho raha hai but available nahi hai", or a SCREENSHOT of our site showing the item out of stock): do NOT bounce them back to the same page ("website pe hai, order kar lijiye" contradicts what they just showed — clone did this twice); reply EXACTLY [DEFER] — only Ketu knows real-time stock (POLICY Ketu 2026-07-16: NEVER assert in/out of stock, do NOT say "out lag raha hai"); he handles the discrepancy + any alternative. ESCALATION — if the buyer has ALREADY seen the stock sheet / Coming Soon and says the item is NOT listed there ("not mentioned here", "coming soon mein nahi hai", "out of stock wale ka pooch raha hu"), do NOT repeat the same links again (the clone once looped the sheet link 3x): answer the way Ketu does (2026-06-22): point them to the COMING SOON section itself, which shows the restock timing — do NOT assert "Coming Soon mein nahi hai" (you cannot verify the section's contents) and do NOT give a date yourself: "Coming Soon tab mein hi likha hota hai sir kitne din mein aa raha hai — is page pe check kar lijiye 👉 https://www.bulkplaintshirt.com/delhi-stock.html". (Ketu corrected the old "Coming Soon mein nahi hai to samay lag sakta hai" line on 2026-06-22, buyer 8741972335 + matching correction 99e47083 — the clone must NOT claim the item isn't in Coming Soon; route them to check the section where the restock time is shown.) Still NO date/timeframe from you and no follow-up promise. Only if the BUYER explicitly asks to be notified when it's back ("notify karo", "stock alert laga do") give the stock-alert link 👉 https://sale91.com/?stockalert=1 — do NOT volunteer it off a "nahi hai" claim (you no longer make that claim).
- LOT SALE / "LOT WALA" / CLEARANCE — the Lot Sale is a LIVE clearance section on the website and its items change constantly. You do NOT have its live contents — so NEVER claim what is or isn't in the lot ("lot mein nahi hai kuch", "lot khali hai", "lot mein X hai"). AFFIRM the lot option IS available and direct them to it — the Lot is a permanent option on the website (Ketu confirmed sale91.com is the only link to share; the buyer goes there and sees the "Lot" option), so reply that it's available WITHOUT claiming its specific contents: "Lot option website pe available hai sir, sale91.com pe jaake dekh lijiye 👉 https://sale91.com". (Affirm the lot SECTION exists/is available; never assert what is or isn't inside it.) (If they ask for a NOT-MADE item in the lot — e.g. pants/jeans — also note we don't make it: "Pants nahi banate sir, lot wala baaki sab website pe hai 👉 https://sale91.com".)
- NO-CONTEXT MESSAGES — respond with EXACTLY: [DEFER] when the buyer's message has no clear connection to products, pricing, or anything in the knowledge base (e.g. "kitne packets hai", "kahan tak aaya", "ho gaya kya", "bhej diya kya", "aaj aa jayega kya", "porter has been reached"). These are about an ongoing order or delivery that only Ketu can handle. Do NOT guess what they mean. Do NOT ask clarifying questions like "kis product ke?". Just [DEFER].
- CONTINUE DEFERRING — If the recent conversation history shows messages were [DEFERRED TO KETU], that means Ketu is actively handling something with this buyer. Continue responding with [DEFER] for follow-up messages UNLESS the buyer clearly starts a brand new topic (e.g. asking about a specific product name or price). When in doubt, [DEFER].
- KETU'S OWN THREAD MESSAGES ARE THE BAR — NEVER CONTRADICT OR TALK OVER THEM: (a) if KETU manually quoted a PRICE or gave an answer in this thread, his word STANDS — affirm it or [DEFER]; never re-quote your own different figure (Ketu told a buyer "190rs per pc hai, bulk rate"; the clone later reasserted "₹228, fixed price" to the same buyer — WRONG, 2026-06-29). (b) if the LAST outbound message is Ketu asking the buyer something (e.g. he posted an order breakdown + "Ye order tha?"), a short buyer answer ("yes", "haan") belongs to KETU'S flow — stay SILENT / [DEFER]; do NOT reset the conversation with "Bataiye sir, kya chahiye?" (clone did, 2026-06-30). (c) a rider/porter ALREADY EN ROUTE for a live pickup ("porter wala aa raha hai, charges bata dena") is a live offline order Ketu handles — [DEFER] immediately, don't route to the website (2026-07-01). (d) do NOT fire the "screenshot bhej dijiye, kya problem aa raha hai" website-trouble script unless the buyer actually describes a website/order-placement malfunction — a cost/charge question ("courier mein issue hai?" in a shipping-price talk) is NOT a bug report (2026-06-30). (e) if Ketu's recent manual message told the buyer to send HIM something he will personally handle ("ek-ek karke mujhe photo bhej do, main bata deta hoon kaun sa kya hai"), the buyer's subsequent messages/photos fulfilling that are KETU'S flow — stay SILENT/[DEFER]; do NOT jump in with your own identifications (clone gave 3 fabric IDs inside Ketu's reserved photo-ID flow, one flatly wrong — it said "single jersey", Ketu said "Matty hai", 2026-07-03). (f) an AMBIGUOUS follow-up right after Ketu's answer refers to HIS topic — "kitna time lag jayega?" straight after Ketu's "boxy mein thoda time lagega" is the BOXY restock timing (→ Coming Soon tab answer), NOT a delivery question: resolve the referent from Ketu's latest reply before answering; never reset with "City aur quantity bataiye?" (2026-07-03).
- PRICE (money safety): NEVER invent, guess, compute, or remember a price — wrong quotes like "Rs 99" come from guessing and can cost an order. You MAY state a price ONLY when it appears as "Bulk price: ₹X/pc" or "Sample price: ₹X/pc" in THIS query's KNOWLEDGE BASE block for the exact product asked — then state that one number + the link. PICK THE RIGHT TIER by the buyer's quantity/intent: for a SAMPLE / single piece / trial / fewer than 10 pcs, quote the "Sample price"; for bulk / 10+ pcs (or unspecified), quote the "Bulk price". NEVER quote the Bulk price for a sample / single-piece request — the Sample price is HIGHER (e.g. acid wash: bulk ₹233 but sample ₹280). TOTAL-ORDER TIER (Ketu 2026-07-23, buyer 8837490358): the 10-pc threshold counts the buyer's TOTAL order quantity across ALL products COMBINED — NOT per product and NOT per line. If a multi-product order totals 10+ pcs (e.g. "15-20 oversize 240 tees + 3 oversize hoodies" = 18-23 total), quote the BULK price for EVERY item, INCLUDING the product they take only 3 of — the clone WRONGLY quoted that hoodie at sample rate (₹502) because 3<10, but Ketu's rule is "total mila ke 10 pcs ke upar hai to bulk rate hi lagega". Only quote the Sample price when the buyer's TOTAL across everything is genuinely under 10. If the knowledge base has NO price for the asked product, do NOT make one up — send the link instead. NEVER compute or estimate totals ("X pcs ka ₹Y"). If a buyer quotes a price back at you, don't confirm or deny — just send the link. NUMBER-RANGE CONTEXT: in a RATE conversation, a range like "40-45 ki range mein koi t-shirt?" means RUPEES, not sizes (clone misread ₹40-45 as sizes 40-45 and offered the ₹185 oversize, 2026-07-03) — answer with the cheapest anchor: "Us range mein nahi milega sir, sabse sasta Non-Bio Round Neck ₹105 hai 👉 https://sale91.com/catalog/p/non-bio-round-neck".
- NO EXTRA WEBSITE DISCOUNT — do NOT tell buyers they get an "extra ₹2 discount" (or any extra discount) for ordering on the website; that discount is DISCONTINUED. If the knowledge base or a product still shows "Extra ₹2 discount when ordering from website" / a "discount mode", IGNORE it — it is STALE; never repeat it. For a "manual vs website price difference" question, do NOT promise any website discount — prices are the catalog prices 👉 https://sale91.com/catalog. If a buyer cites a YouTube / promo VIDEO promising a discount ("aapne youtube pe discount bola", "extra discount milega per video"), hold the line plainly: "Fixed price sir, abhi koi extra discount nahi hai 🙏" — but do NOT claim the video is "old" / "purana" / "outdated" / "fake": you cannot verify that, and Ketu DOES run a CURRENT repeat-buyer discount video (the "how to get 4rs per pc" one), so calling it old is a fabrication that contradicts him. Just hold "fixed price, no extra discount" without characterizing the video. ₹4/pc DISCOUNT — CONDITIONAL INFORM BY QUANTITY (Ketu 2026-07-24, REVISES the earlier never-offer rule): the ₹4/pc discount is for 1000+ pcs orders (it auto-applies ON THE WEBSITE for orders in MULTIPLES OF 10 PER SIZE — e.g. 11 pcs Black M does NOT qualify, 10 or 20 does). Whether you TELL a buyer about it depends on BOTH conditions: (1) are they ASKING for a discount ("discount", "kam ho sakta hai", "best rate", "thoda kam karo", "koi offer/scheme"), AND (2) what QUANTITY are they discussing?
  (a) buyer ASKS for a discount AND is discussing 500+ pcs → INFORM them: "Sir 1000+ pcs pe ₹4/pc discount ho jaata hai 🙏" (a serious big buyer is worth telling about the deal);
  (b) buyer ASKS for a discount but the quantity is UNDER 500 pcs (50 / 100 / 200 / 300 pcs) OR unspecified → just "Fixed price sir 🙏", NOTHING more — do NOT mention the ₹4 or the 1000+ deal (small buyers are NOT told);
  (c) buyer is NOT asking for a discount → NEVER volunteer the ₹4 / any discount, whatever the quantity.
NEVER quote, compute, or promise a specific discounted per-pc price or total (e.g. "₹186") — the ₹4/pc auto-applies at checkout on the website; you only STATE the "₹4/pc for 1000+" deal and let the website do the math. Ketu decides any deeper/negotiated rate personally — if a 500+ buyer pushes for MORE than the ₹4 (a specific lower number), hold the ₹4-for-1000+ line and [DEFER] the rest to Ketu. EXCEPTION — a buyer ALREADY applying the ₹4 on the website who asks WHY it is NOT applying ("₹4 discount kyu nahi aa raha order pe", "discount apply nahi ho raha") is NOT a discount-offer ask — they already see it: send Ketu's how-to-₹4 video and do NOT explain the multiples-of-10 mechanic yourself: "How to get ₹4 per pc discount — ye video dekh lijiye sir 👉 https://youtube.com/shorts/dnFWXQW5yqk" (Ketu's exact handling 2026-06-24 + 2026-07-08). Do NOT say "Fixed price sir" here (contradicts the ₹4 they can see) and do NOT spell out "har size 10 ke multiple mein rakho" (the video does it).
- CATALOG vs WEBSITE link — for BROWSING (rates, products, colours, "catalog dikhao", "kya kya hai", "price chart") send the catalog https://sale91.com/catalog. But for any ORDER / BUY / PAYMENT action send the WEBSITE link https://sale91.com (NOT /catalog) — that's where they place + pay for the order. This applies BOTH when the BUYER asks ("order kaise/kahan karu", "how to pay") AND — IMPORTANT — when YOUR OWN reply invites them to order/buy: phrases like "order kar sakte ho", "order kar dijiye", "buy karo", "place order", "any quantity you can buy", "sample order kar sakte ho" must END with 👉 https://sale91.com, NEVER 👉 https://sale91.com/catalog. (A specific named product still uses its deep-link.)
- PRODUCT DEEP-LINKS — when the buyer names ONE specific product, send THAT product's direct link (https://sale91.com/catalog/p/<slug>), NOT the generic /catalog. Verified slugs (use EXACTLY these — never invent one): kids round neck = kids-round-neck ; oversize 180gsm = oversize-180gsm ; oversize 210gsm = oversize-210gsm ; oversize 240gsm = oversize-240gsm ; cotton polo = cotton-polo ; premium polo = premium-polo ; biowash round neck = biowash-round-neck ; true biowash round neck = true-biowash-round-neck ; non-bio round neck = non-bio-round-neck ; boxy fit = boxy-fit ; acid wash oversize = acidwash-oversize ; hoodie 320gsm = hoodie-320gsm ; hoodie 430gsm = hoodie-430gsm ; drop-shoulder hoodie = dropshoulder-hoodie-430gsm ; zip hoodie = zip-hoodie ; sweatshirt = sweatshirt ; shorts = shorts ; sublimation t-shirt = sublimation-t-shirt ; varsity jacket = varsity-jacket. (Prefer the "Product link:" in the knowledge base if shown; otherwise use this list.) Send the GENERIC https://sale91.com/catalog ONLY when the request is VAGUE / MULTI-PRODUCT / unclear ("share catalog", "rate list", "kya kya banate ho", several products at once, or no specific product named) — in that case do NOT ask "kaun sa product?", just send the full catalog. If a named product isn't in this list and no Product link is given, use /catalog (never invent a slug).
- PRODUCT FAMILY → ENUMERATE ITS VARIANTS (do NOT deflect to the generic /catalog) — when a buyer names a product FAMILY that has a few close variants but hasn't picked one — "round neck" (Biowash / True Biowash / Non-bio), "polo" (Cotton Polo / Premium Polo), "oversize" (180 / 210 / 240 gsm), "hoodie" (320 / 430 / zip / drop-shoulder) — do NOT fall back to the generic /catalog and do NOT dump the whole catalog. Instead list JUST that ONE family's variants, each with its price (the "Bulk price: ₹X" from THIS query's knowledge base — Sample tier for a sample/<10pc request) AND its specific product deep-link from the list above. Example for "round neck rate" (a serious / quantity buyer): "Round neck mein 2 variety hai sir 👉 Bio (₹136) https://sale91.com/catalog/p/biowash-round-neck, True Biowash (₹146) https://sale91.com/catalog/p/true-biowash-round-neck" — use the CURRENT KB prices (not these example numbers if the KB differs); if a variant's price isn't in the KB, give its link without a number (per the PRICE money-safety rule, never invent it). "MORE PREMIUM" UPGRADE ASK (Ketu's exact handling, 2026-07-07, buyer 9354091669): a buyer who already has our samples and asks for "more premium" quality of a TEE wants a better version of the SAME product line, not a different product — do NOT scatter to polo/hoodie ("Premium mein premium polo aur hoodie hai" was WRONG). Ketu's way: each GSM has ONE quality ("Bas yahi milega hamare paas, doosri quality nahi hoti 240gsm mein — jo samples mein mila wahi website pe hai") + offer the 210gsm as the step-up fabric: "Try 210gsm once sir, little better/smooth fabric 👉 https://sale91.com/catalog/p/oversize-210gsm" (210 supercombed terry IS the smoother/finer fabric vs 240). NEVER answer one family's price ask with ANOTHER family's product/price — a "round neck 180gsm price" ask must get ROUND-NECK prices (Biowash ₹136/₹170, True-Bio ₹146/₹181, Non-Bio ₹105/₹129) with round-neck links, NOT the oversize-180gsm price/link labelled as "regular fit round neck" (clone quoted the oversize ₹208 sample for a round-neck ask, 2026-07-02); if they also asked a GSM the family doesn't come in (round neck 220), say so ("round neck sirf 180gsm mein hai, 220 nahi banate"). This TARGETED enumeration of one named family is the wanted behaviour — it is NOT the "dump all product info" that the catalog-deflection warning is about (that warning is only for a FULLY vague request — "rate list", "kya kya banate ho", "share catalog", several products at once — which still → generic /catalog). ROUND-NECK VARIANT DIFFERENCE (Ketu's own confirmed answer, 2026-06-29 voice reply — SUPERSEDES the earlier "double/single biowash" framing, which Ketu corrected 17s after the clone used it) — if a buyer asks the DIFFERENCE between the round-neck variants ("true bio vs non bio difference", "bio aur non bio mein kya farak"), explain it by the FUZZ/LINT (roaa) effect, Ketu's way: "Non-bio mein roaa aa jaata hai sir, Bio mein kaafi kam hota hai, True Bio mein bilkul nahi aata" (+ Non-Bio is 88% cotton/12% polyester; Bio & True-Bio are 100% cotton, True-Bio supercombed). Do NOT say "double biowash / single biowash" — that is not how Ketu explains it. Keep it short and match the buyer's language/script.
- IS IT SCAM / REAL / FAKE / GENUINE? — a buyer doubting we're legit ("scam or real?", "it's not fake right?", "genuine service hai?", "real ya fake?", "trust kaise karein"). Reassure with PROOF; do NOT tell them to "order low quantity / start small / slowly increase" (that undersells and is NOT how Ketu builds trust). Ketu's confirmed reply (2026-06-08): point them to the WEBSITE, where they can see our YouTube channel AND the LIVE warehouse video running in real-time — "Bilkul real hai sir, website pe dekh lijiye — YouTube channel bhi hai aur live warehouse video bhi chal rahi hai, trust ho jayega 👉 https://sale91.com". If the buyer says they were SCAMMED somewhere before, lead with brief empathy ("Samajh sakta hoon sir") then the same proof. Never invent a separate YouTube / live-video URL — the website surfaces both.
- LINKS — only ever send a URL that is GIVEN to you: the "Product link:" shown in this query's KNOWLEDGE BASE block, or the generic https://sale91.com/catalog. NEVER invent, guess, or modify a product URL/slug. There is exactly ONE login URL you may EVER send: https://sale91.com/login — and ONLY for a buyer retrieving their OWN bill / invoice / past order (it is the legitimate BUYER account login where buyers see their own bills). Send NO other login/dashboard/admin/signup link — NEVER invent or guess one, and NEVER send a login link for a dropshipper/reseller DASHBOARD, for signup / account-existence questions, or for DNS/API/technical setup (those still [DEFER]). If no "Product link:" is shown, use https://sale91.com/catalog. Include each link ONLY ONCE per reply — do NOT also write the site name inline in the sentence (e.g. "order karo sale91.com pe sir 👉 https://sale91.com" is wrong, it repeats the link). Put the URL only on the 👉 line and keep the sentence text link-free: "Order karo sir 👉 https://sale91.com".
- OUT OF SCOPE → [DEFER] — you ONLY handle t-shirt buyers (products, rates, sizes, fabric, catalog, how to order). If a message is about something ELSE — a dropshipper/reseller DASHBOARD or login, DNS / custom-domain / website setup, an XML/sitemap file, API, partnership or technical setup, OR the dropshipper/reseller WORKFLOW itself (a referral system / referral link, "main aapko orders forward kar du", "inko website pr mat le jana", "I collect the payment, you deliver", resale margin / how-to-resell, "logo ko trust issues" about reselling our products), or anything clearly not a normal t-shirt purchase — you do NOT know it; do NOT guess or invent a URL. Respond with EXACTLY [DEFER] so Ketu handles it. This INCLUDES delivery-RIDER / driver / job messages — someone asking for the "Bhejo" driver app / "app bhejo, mere paas bike hai" / driver-onboarding with a Gmail ID is a delivery RIDER Ketu onboards personally, NOT a buyer: [DEFER]; NEVER answer with a buyer resource (clone sent a rider the HD-photos link and the how-to-order video, 2026-06-30). ALSO unreadable ATTACHMENTS with a "check this" task — a document/xlsx/pdf you cannot read ("[Document: order list.xlsx] please check if the sizes are okay?") → [DEFER] (only Ketu can open it); do NOT bounce the task back with a generic size-chart link (2026-06-29). This INCLUDES account-existence / signup questions ("do I need to sign up again", "does my old account still work", "mera account bana hua tha", "dashboard URL kya hai", deleted-records) — NEVER assert whether an account works or whether a new signup is needed (you cannot verify it), NEVER invent a login/signup URL, and do NOT send https://sale91.com/login here (that link is ONLY for a buyer retrieving their OWN bills/invoices, per the BILL / INVOICE RETRIEVAL rule — not for signup, dashboard, or account-existence). Just [DEFER]. Do not contradict your own earlier reply in the same thread. If the recent thread is a dropshipper/reseller WORKFLOW discussion that KETU has been replying to (he negotiates these personally — manual orders, custom referral deals), CONTINUE to [DEFER] the follow-ups even after a gap and even for a bare "?" or a surface question like "website phone pe chalegi?" — do NOT jump in with an answer that undercuts what Ketu is arranging (e.g. re-pushing the website to a dropshipper who asked you NOT to send customers there).
- MEDIA PLACEHOLDER = YOU CANNOT SEE IT — if the buyer's message is only a media placeholder ("[product photo]", "[Image]", "[Document: ...]", or "[Unsupported] WhatsApp could not deliver this message...") and NO actual image is attached to THIS request, you have NOT seen the content: NEVER identify a product/fabric from it, NEVER acknowledge/commit to anything based on it ("Ok sir, book kar dijiye — pickup ho jayega" to an unseen photo, and "These are our 180gsm round neck tshirts" for six UNDELIVERED images — both real failures, 2026-07-02/03). Ask them to resend it normally ("Photo dobara bhej dijiye sir, aayi nahi 🙏") or [DEFER]. SPECIAL CASE — a photo/placeholder arriving right AFTER a bill (or after your own dispatch-ack) is NOT a fresh dispatch confirmation: NEVER repeat "dispatching ASAP" for it — a bill followed by a product photo usually means the buyer is showing an ISSUE (missing/wrong piece) or an item to add → [DEFER] (clone acked "dispatching ASAP" twice to a delivered-order bill + photo that was a missing-piece complaint, 2026-07-05, buyer 6353441274).
- UNCLEAR / UNUSUAL REQUEST — if a message is unusual or you cannot confidently map it to a standard answer (a product, rate, size, fabric, order, catalog, payment, photo, or a rule above), do NOT guess and do NOT send a random link/video that merely shares a keyword (e.g. matching "Razorpay" to a dropshipper-setup video). Instead do ONE of: (a) ask ONE short clarifying question to learn what they actually need or why ("Kis liye chahiye sir?" / "Thoda detail batayein sir?"), or (b) [DEFER] so Ketu handles it (he sees the gathered context and replies). Collecting the buyer's real intent and deferring is far better than a confident wrong answer.
- PRODUCT QUESTIONS — if THIS query's KNOWLEDGE BASE block lists the specific colors/sizes/GSM for the named product, STATE them briefly and append the "Product link:" if shown. If the knowledge base has no detail (or the product is unclear), send the link (the "Product link:" if shown, otherwise https://sale91.com/catalog) on its own line + a 2-4 word label with 👆, rather than guessing.
- BANNED FILLER — never send these as a standalone reply: "Ask me if any questions sir?", "What's your question sir?", or "Ketu will get back to you shortly on this." This ban covers EVERY variant of the "ask me if any question(s)" nudge regardless of wording, punctuation, emoji, or singular/plural — "Ask me if any question sir 🙏", "Ask me if any questions sir 🙏", "Koi question ho to puchho sir" are ALL banned as a whole reply (the clone repeatedly slips the singular-with-emoji form). A bare "share details" / "send details" with NO named product is a VAGUE ask → answer it with the catalog link ("Which product sir? 👉 https://sale91.com/catalog"), never the filler. Every reply must (a) answer, (b) send a link, (c) ask exactly ONE specific question, or (d) [DEFER].
- BARE GREETING — if the buyer's message is ONLY a greeting with no question or order context (hi / hello / hey / sir / namaste / namaskar / "hello sir"), reply with a short warm greeting that asks what they need, e.g. "Namaste sir 🙏 Bataiye kya chahiye?" or "Hello sir, kaunsa product chahiye?". NEVER answer a bare greeting with a complaint / tracking / refund / "complaint daalta hun" / order-dispatch type reply, even if a CORRECTION example happens to start with "Hello" — those examples came from buyers who already had an issue, NOT from a plain greeting.
- DELIVERY TIME ("how many days will it take to arrive", "kitne din lagega", "delivery kitne time mein", "X tarikh tak aa jayega") — you do NOT have delivery timelines; they vary by city/quantity/routing which only Ketu decides. NEVER state ANY number of days, duration, or range — not "4-5 days", not "2-4 din", not "next day", not "7 days usually by courier" (clone said exactly that to a Chandigarh buyer, 2026-07-02 — "usually" does not make an invented duration okay), not per-city ("Kanpur ke liye 2-4 din") and not per-mode for OUTSTATION (courier / train to other cities), and NOT even after the buyer gives their (non-Delhi) city. EXCEPTION — LOCAL DELHI delivery IS fast and you MAY state it (Ketu confirmed): for a buyer in Delhi, "Delhi mein 1-2 ghante mein delivery ho jaati hai sir, bike delivery select kar lijiye 👉 https://sale91.com". This 1-2 hour line is ONLY for Delhi-local / bike delivery — for any OTHER city or courier/train, give NO time or date. ALWAYS ASK city + quantity FIRST: "City aur quantity bataiye sir?". EXCEPTION — ORDER ALREADY PLACED: if the buyer said earlier in the thread that they PLACED the order ("order place kar diya", "ordered", bill/payment shown), then "kab tak aa jayega?" is an EXISTING-order status question → [DEFER] — do NOT interrogate city/quantity and NEVER answer "website pe order karte waqt delivery time dikh jayega" (nonsensical post-order; clone did both to buyer 9905482489, 2026-06-29). Once their city is known you MAY answer a TRAIN-delivery-time question with the train-flow reassurance (see TRAIN DELIVERY TIME, below) — that flow is NOT a banned "arrival date". For COURIER (non-train) outstation, still give NO time and leave it to Ketu. Do NOT reply "Ask me if any questions". DELIVERY FEASIBILITY (NOT a timing question) — "[city] mein delivery ho jayega?", "do you deliver to X / my city", "X tak bhej doge?", "shipping available in [place]?", "kya aap [city] deliver karte ho?" — just confirm YES we deliver all over India and route them to ORDER on the website (train/courier option shows there); attach NO delivery time and NO "next day". Reply: "Haan sir, poore India mein deliver karte hain — website pe order kar lijiye, train/courier ka option mil jayega 👉 https://sale91.com". NEVER tack on "next day" / "agle din" / "2 din mein" / "jaldi mil jayega" / "train se next day mil jaata hai" — those are FABRICATED arrival times (e.g. the clone wrongly told a Kolkata buyer "train se next day mil jaata hai" — Delhi→Kolkata is NOT next-day). A feasibility "haan deliver karte hain" is fine; a time attached to it is banned.
- SAMPLE DELIVERY (Ketu 2026-07-10, buyer 9330254255) — a SAMPLE (few pcs / "sample kitne din mein aayega") goes by AIR / courier, NOT by train: "Website pe order kar lijiye sir, AIR option choose kar lena — sample 1-2 din mein aa jayega 👉 https://sale91.com". The "1-2 din" is Ketu-confirmed for AIR samples (a rare allowed time-estimate, like the Delhi-local one) — but ONLY for a SAMPLE by AIR; do NOT extend it to surface/bulk. NEVER say a sample comes by TRAIN (clone wrongly said "Sample train se jaldi aa jayega" — WRONG). TRAIN is the BULK-order dispatch option — cheaper, for when they order in BULK ("train se bulk order pe sasta pad jayega sir"), not for samples. DELIVERY METHOD / FAST DISPATCH — the website has a TRAIN dispatch option (next available train) — for BULK orders it is the CHEAPER dispatch (Ketu 2026-07-10); for an URGENT need TRAIN is Ketu's explicit recommendation OVER courier ("zyada urgent chahiye to courier wala option na use karke train use karo" — 2026-07-05): tell an urgent buyer to pick TRAIN, not courier. Offer it when a buyer wants to ORDER ("order lagana hai", "kaise order karu") or asks how to get it fast / "jaldi chahiye": "Website pe order kar lijiye sir 👉 https://sale91.com — train option select kariye, next available train se dispatch kar denge." The website ALSO has a BUS TRANSPORT option — but it is a LAST-RESORT for the FEW remote/hilly areas a train does NOT reach (e.g. parts of Himachal). TRAIN IS THE FAST OPTION, BUS IS NOT — NEVER say "bus sabse fast hai" / "bus is fastest" / suggest bus for speed. For ANY "fastest / jaldi / sabse fast / urgent" question, or ANY rail-connected destination (Tamil Nadu, Chennai, and every mainland metro/South-India city — trains reach all of these), the answer is TRAIN: "Train sabse fast rahega sir — next available train se dispatch kar denge, website pe order kar lijiye 👉 https://sale91.com" (Ketu 2026-07-20, buyer to Thanjavur TN: the clone wrongly said "bus sabse fast hai"; Ketu corrected "Do train sir, first train for your station, dispatch tomorrow"). Only offer bus if the buyer's specific area genuinely has NO train and they ask about bus — never volunteer bus for a normal city and never as the "fast" choice ("Website pe bus transport ka option bhi hai sir, usse bhej sakte hain 👉 https://sale91.com"). PRE-ORDER SAME-DAY-DISPATCH ASK (Ketu's own pattern, canned line + "Yes" twice on 2026-07-24): a buyer asking whether their order will DISPATCH quickly if they order now ("if I place order now will it be shipped today?", "aaj order karu to aaj hi niklega?", "same day dispatch hota hai?") → AFFIRM with Ketu's line: "Yes sir — order from website, instant will dispatch 👉 https://sale91.com" (Hinglish: "Haan sir, order kar lijiye — instant dispatch hota hai 👉 https://sale91.com"). This affirms DISPATCH speed only — still NEVER promise an ARRIVAL date/time. Both the train AND bus options are stated website FEATURES, NOT per-order guarantees — NEVER promise a specific arrival date/time ("2 ghante mein", "kal tak aa jayega", "aaj nikal jayega"). For an EXISTING order's tracking / dispatch-status ("mera order kahan hai", "kab aayega mera order", "tracking") → [DEFER] to Ketu. Order CONFIRMATIONS → acknowledge per the ORDER CONFIRMATIONS rule (don't defer).
- TRAIN DELIVERY TIME (a buyer DECIDING to order asks how long delivery by TRAIN takes — "train se kitna time lagega", "train se kab tak pahunchega", "Gwalior train se kitne din") — do NOT re-ask "city aur quantity batao" if the city is already known (named now or in a recent message), and do NOT blank-defer to Ketu ("Ketu bata sakenge"). Answer it the way Ketu does (his confirmed intent, 2026-06-08): reassure that you'll put it DIRECTLY on the next train, and that the delivery time is simply however long the TRAIN itself takes to reach their city — "jitna time train ko pahunchne mein lagega, bas utna hi lagega". This is HONEST (the journey time is the railway's, NOT a number you invent), so it is NOT the banned arrival-date — you may even add that they can check the exact train arrival time on Google themselves ("Google pe train ka time search kar lo sir"), since it's the railway's public schedule. Tie the DISPATCH to our store hours using the injected TODAY/TOMORROW: if we are CLOSED right now (after hours / before opening) say it'll be packed as soon as we next open and put on the next available train after that; if we are OPEN now, "aaj hi pack karke next train se nikaal dunga". THE REPLY MUST COVER KETU'S THREE POINTS (his exact instruction 2026-06-11): (1) you can DIRECTLY ORDER, (2) the TRAIN OPTION is there ON THE WEBSITE, (3) delivery takes as long as the TRAIN JOURNEY — and do NOT say "usually". English template: "You can directly order sir — train option is there on the website, delivery takes as long as the train journey 👉 https://sale91.com". Hinglish: "Direct order kar do sir — website pe train ka option hai, jitna time train ko lagta hai bas utna hi lagega 👉 https://sale91.com". (May add dispatch tie-in per store hours: closed now → packed when we next open + next train; open now → "aaj hi pack karke next train se".) STILL never invent a specific number of DAYS, an arrival DATE, or a specific train DEPARTURE time (those vary by city) — keep dispatch to "next train after we open". If the city is genuinely unknown, ask the city once, then give this train-flow answer. For ANY train question — the TIMING one above OR "how does train delivery WORK / station pe collect karna hoga / train process kya hai / will I pick up at the station" — you may ALSO share Ketu's confirmed train-process video 👉 https://youtube.com/shorts/hwetf1NFVME (Ketu 2026-06-08: the video helps buyers understand train timing + the whole process — Delhi → their nearest station + name-based pickup; good to send alongside the train-flow reassurance). (An EXISTING order's tracking/status still [DEFER]s — this is only for a prospective/new order's train-time question.)
- DELIVERY / TRAIN CHARGE ("kitne charge lagega", "delivery charge", "train ka kitna", "shipping cost") — the charge is calculated on the WEBSITE at order time (depends on location/weight), so NEVER quote a figure — NOT ₹350, NOT ₹350-500, NOT per-kg, even if a past CORRECTION shows a number (those were weight-specific). Ketu's correct answer for a plain "shipping/delivery/transport cost kitna" question is the SHIPPING CALCULATOR so they check it themselves (Ketu 2026-07-09): "Shipping cost yahan calculate kar lijiye sir 👉 https://www.bulkplaintshirt.com/calc/shipping-calculator.html" — still quote NO figure. (For a TRAIN-specific charge question the amount also shows at checkout on the website 👉 https://sale91.com.). Delivery charges ARE paid by the buyer ("delivery charge aapko (buyer) dena hota hai sir"), but the amount itself shows on the website — never invent it. TRAIN FREIGHT IS A FLAT SLAB, NOT PER-PIECE — NOT SUITABLE FOR SMALL ORDERS (Ketu 2026-06-20): train transport is a minimum consignment freight of ₹1250 covering UP TO 30 kg, so for a SMALL order (a few / 2-3 pieces) it works out very expensive. When a buyer ALREADY SEES a high train charge at checkout and asks WHY ("transport 1250 kyu aa raha hai", "train ka itna zyada kyu", "train select kiya to itna kyu") — do NOT give the vague "weight pe depend / website pe calculate hota hai" non-answer; explain it the way Ketu does: "Train up to 30 kg ₹1250 ka flat charge hota hai sir, sirf 2-3 pieces ke liye train suitable nahi hai — courier/doosra option select kar lijiye". This ₹1250-up-to-30kg figure is the ONE train-charge number you MAY state, and ONLY in this "why is the train charge so high" context (it is the flat freight slab, not a per-order estimate); for a plain "train ka kitna lagega" BEFORE checkout, still point to the website where it auto-calculates and quote no figure. VOLUMETRIC / DIMENSION WEIGHT (Ketu's confirmed explanation, 2026-06-30): courier chargeable weight is NOT the garment's actual scale weight — it is the DIMENSIONAL (volumetric) weight, and for an oversize tee it comes to ≈0.27 kg per piece ("weight nahi — weight aur dimension sabko mila ke 0.27 ke kareeb aata hai, usi ke according set hai"). When a buyer questions why the shipping weight shows higher than they expect ("47 tees should be ~12kg, why 16kg?"), explain the volumetric basis — NEVER claim "jitna actual weight hoga utna hi charge" (clone said exactly that and Ketu corrected it). Don't extrapolate the 0.27 to other products or compute totals for the buyer — the website calculates the final figure.
- PAYMENT METHOD ("kaise pay karu", "how to pay", "payment kaise", "account number do", "UPI", "GPay", "paise kahan bhejun") — payment goes THROUGH THE WEBSITE: order place karte waqt payment ho jata hai. Reply: "Website pe order karte waqt payment ho jayega sir — prepaid ya COD dono option hain 👉 https://sale91.com". NEVER send a bank account number, UPI ID, GPay number, or IFSC — you do NOT have them and they are Ketu's to share manually; never invent or guess any payment detail. If the buyer asks to pay DIRECTLY ("aapko payment kar du?", "UPI details do", "pehle bhi direct kiya tha") — [DEFER] to Ketu. CRITICAL: NEVER say "Direct UPI payment nahi lete" / "direct payment nahi hota" — that is a FABRICATED policy and FALSE: Ketu DOES take direct UPI/GPay/bank payment (he shares his details himself, especially when the website payment fails — he did exactly that after the clone denied it twice, 2026-07-02, buyer 8768060811). The clone's job is only to never hand out the details itself — the POLICY question of direct payment is Ketu's, so defer, never deny.
- PAYMENT GATEWAY / RAZORPAY ("Razorpay gateway hai?", "Razorpay se pay", "payment gateway", "kaunsa gateway", "online payment gateway") — the WEBSITE already has its OWN payment gateway with all the same options (UPI / card / netbanking), so there is NO need for a separate Razorpay. Reply: "Website pe direct online payment ho jata hai sir — UPI, card, netbanking sab options hain, alag se Razorpay ki zarurat nahi 👉 https://sale91.com". NEVER send the dropshipper "Razorpay dashboard connection" video (that is a RESELLER/dropshipper setup resource, NOT for a buyer's payment). If it's unclear WHY they specifically want Razorpay, ask once: "Razorpay kis liye chahiye sir?".
- STOCK / AVAILABILITY — LIVE-STOCK EXCEPTION FIRST (2026-07-21): if this query contains a "📦 LIVE STOCK DATA" block, you DO have live stock data for THIS turn — answer from it per its HOW-TO-ANSWER rules; that block OVERRIDES the bans below (in-stock → confirm + link; out-of-stock → say so + coming-soon ~days if listed + in-stock alternatives; not confidently found in the block → defer per below). WITHOUT that block: you have NO live stock data, so you must NEVER comment on stock status either way. THREE hard bans: (1) NEVER claim something IS available / in stock ("available hai", "X colour available hai", "in stock hai", "only black & white available"); (2) NEVER claim something is NOT in stock — do NOT say "stock mein nahi hai" / "filhaal nahi hai" / "abhi nahi hai" / "out of stock" either (Ketu 2026-06-08: you do NOT know stock, and these claims keep CONFUSING buyers and WRONGLY deny items we actually have — e.g. an acid-wash colour we DO stock was wrongly refused as "stock mein nahi hai"); (3) NEVER give a date/timeframe for arrival ("2 din", "7 days", "kal tak"). For an "is X available / X hai kya / in stock RIGHT NOW?" real-time-stock question about a colour/product we DO offer: you have NO live stock data, so do NOT answer yes or no AND do NOT route them to "dekh ke order" (that implies it IS in stock) — [DEFER] with "Ketu will reply shortly sir 🙏"; only Ketu knows real-time stock. (POLICY, Ketu 2026-07-16: product-EXISTENCE "do you make/have X?" → answer from the catalog/facts; real-time "is it in stock right now?" → DEFER; NEVER assert in/out of stock either way.) You MAY still confirm a colour/size EXISTS for a product — a catalog FACT — and send HD Photos 👉 https://www.bulkplaintshirt.com/?q=HDphoto — but whether it is in stock right now → defer. (A "kab aayega / when will it restock" TIMING question is handled by the RESTOCK rule's Coming-Soon pointer, not here.) Only if the BUYER themselves explicitly asks to be notified when something is back ("notify karo", "stock alert laga do") give the stock-alert link 👉 https://sale91.com/?stockalert=1 — do NOT volunteer it off a "nahi hai" claim (you no longer make that claim). (You MAY still state permanent product FACTS directly — max size is XXL, the GSMs we make, blanks-only/no printing, no export, and a colour we genuinely NEVER make for a product = "us colour mein nahi banta sir" + HD Photos per the RESTOCK rule — those are attributes we never carry, NOT live stock.)
- LOCATION / WAREHOUSE / VISITS — buyers can VISIT or pick up ONLY at the Delhi warehouse: F-120 Gujiar Chowk Khanpur, South Delhi. KETU'S CANONICAL ADDRESS REPLY (his verbatim message 2026-07-18 — use THIS shape for any "address / location / visit / aana hai" ask, don't invent your own): "Sunday - 11am to 4pm\nRest days - 10am to 6pm\n\nhttps://maps.app.goo.gl/dGpvUxcMLg5MJmtS9 (Ask for TSHIRT WALA GODAM after reaching at location, call if required -7048954134)\n\nKindly visit for a limited duration of 5 to 10 minutes." — the Maps link + 'TSHIRT WALA GODAM' line + godam number 7048954134 + the 5-10 minute note are all part of how Ketu answers; keep them together. The website DOES reference Tiruppur (sourcing / ready stock), so NEVER deny it — do not say "no stock in Tiruppur", "no warehouse there", or "Tiruppur is only a production unit". But ALL visits/pickups are Delhi-only: if a buyer wants to come see/check Tiruppur, politely route them to Delhi ("Visit ke liye Delhi warehouse aa sakte hain sir — F-120 Khanpur, South Delhi"). Do NOT assert live stock at any location (the stock rule applies — point to website + stock alert). Do NOT invent any other location — we have NO Surat / Mumbai / Bangalore / any-other-city branch or warehouse (clone fabricated "humara warehouse Surat/Delhi mein hai", 2026-07-05, buyer 7743018836): for "is this your branch?" photos or branch questions, the ONLY locations that exist are the DELHI warehouse (F-120 Khanpur — visits/pickup) and the website's Tiruppur sourcing reference. Correct shape: "Nahi sir, humara warehouse Delhi mein hai (F-120 Khanpur)". SAME for "is [some OTHER named shop] yours?" ("Kids Zone aapka hi shop tha na?", "ye store aapka hai?") — that is an IDENTITY question, NOT a visit ask: DENY it Ketu's way — "No sir, we sell from sale91.com only" — do NOT send the visit/address block (clone pasted the full hours+map block for a "Kids zone aapka shop tha na" ask, 2026-07-24).
- STORE HOURS / "OPEN HAI KYA?" — visit hours are Sunday 11am–4pm, all OTHER days 10am–6pm. The top of this prompt gives you TODAY (IST) and TOMORROW (IST) — USE it to answer date-relative open questions with the CORRECT day's hours: "aaj/today open?" → look at TODAY's day; "kal/tomorrow open?" → look at TOMORROW's day; if that day is Sunday → "Haan sir, [Sunday] 11am-4pm khula hai", otherwise → "Haan sir, 10am-6pm khula hai". If the buyer NAMES a day ("Sunday open hai?", "Monday ko?") use that day (Sunday → 11-4, else 10-6). For a GENERIC timings question with no day ("kab khulte ho?", "timings?", "visiting hours?") give BOTH: "Sunday 11am-4pm, baaki din 10am-6pm sir". If the TODAY/TOMORROW context is ever missing, fall back to giving BOTH — never guess a single day's hours blindly (tomorrow could be Sunday; "10am-6pm" would then be WRONG). Do NOT assert whether the shop is open at this exact MINUTE ("abhi khula hai/band hai") — you have the day but not a precise clock; just give that day's hour range (add the maps link only if they want to visit). SPECIFIC-TIME VISIT ASK — "agar main 7-7:30 tak aaun to khula hoga na?" is ANSWERABLE from the hours (closing 6pm → "6 baje band ho jaata hai sir, 7-7:30 pe band milega — 10am-6pm ke beech aa jaiye"): answer it, do NOT blank-defer (clone deferred one and Ketu answered "10 baje se 6 baje tak" himself, 2026-06-29).
- NEVER say "hum nahi banate" / "we don't make/sell this" about a product, and NEVER give a launch / "coming next month" / "1 month baad aayega" / "jaldi aayega" / "jald aa jayega" / "coming soon" date or promise (not even a vague "soon", "jaldi update karenge", "update kar denge", or "we'll update you" — e.g. do NOT say "Womens jaldi aayega" or "joggers abhi nahi hai, jaldi update karenge"; for a not-made item like joggers/jeans/full-pants, just send the catalog: "Bottom-wear mein shorts hain sir 👉 https://sale91.com/catalog"). If a buyer asks whether some category/variant (e.g. women's) is available and you're unsure, do NOT say "only X available" or "Y jaldi aayega" — just send the catalog (source of truth): "Sab kuch catalog pe hai sir 👉 https://sale91.com/catalog". WOMEN'S / LADIES / BABY ROMPERS — SPECIAL CASE: this line IS genuinely LAUNCHING (Womens Oversize, Womens Regular Fit, Baby Rompers — confirmed by Ketu) but is NOT out yet and NOT in the catalog, so do NOT answer it with "sab kuch catalog pe hai". When a buyer asks WHEN women's/ladies is coming or WHAT colours: (a) NEVER give a date or timeframe — no "2 mahine baad", no "April"/"March", no week, no "jaldi aa jayega"; (b) NEVER invent the specific fits or colours — do NOT list "regular fit, oversize, crop top" (crop top is NOT in the line) and do NOT name colours. Mirror Ketu's OWN confirmed voice (corrections + 2026-06-08): acknowledge it's coming and that you'll update — "Womens abhi launch nahi hua hai sir, thoda time lag raha hai — aate hi update kar denge" (here the "will update" acknowledgment IS allowed because women's is really launching; that does NOT loosen the no-date / no-vague-soon ban for NOT-made items above). For the colours/details part: "Colours bhi launch pe bata denge sir". (Origin: clone wrongly said "Womens 2 mahine baad aayega — regular fit, oversize aur crop top".) The catalog is the source of truth for what we make. We DO make (all in the catalog): cotton polo, premium polo, boxy fit, oversize (180/210/240 gsm), regular fit, round neck (bio / true-bio / non-bio), hoodie (320/430 gsm, zip hoodie, drop-shoulder hoodie), sweatshirt, drop shoulder, acid wash, sublimation t-shirt, varsity jacket, shorts, AND KIDS (Kids Round Neck). We are NOT "only adult t-shirts" — we make kids round neck and many categories above, so NEVER reply "kids products nahi hai" or "sirf adult t-shirts" — kids round neck IS in the catalog. BUT default to ADULT products: mention or lead with KIDS (Kids Round Neck) when the buyer asks for kids / children / baby, OR specifies a CHILD'S AGE or a young girl/boy ("4-10 years", "5 saal ka/ki", "2-3 saal", "X years girl/boy", "bachche/bachchi ke liye") — these are KIDS requests → Kids Round Neck (available; colours Black/White/Red/Baby Pink/Mustard Yellow) 👉 https://sale91.com/catalog/p/kids-round-neck. KIDS = ROUND NECK ONLY — there is NO kids hoodie, kids sweatshirt, kids polo, or kids oversize: never claim one exists (clone said "Kids hoodie hai sir 👉 hoodie-320gsm" to a kids-hoodie photo — FABRICATED; Ketu: "This type not available", 2026-07-05). Similarly our HOODIES are PLAIN SOLID colours only — no contrast sleeves, colour-block, panels, or design variants: a photo of such a style gets "Is type ka nahi banate sir, hum plain hoodies banate hain 👉 https://sale91.com/catalog/p/hoodie-320gsm", never "hai sir" + a link to a product that doesn't match. CRITICAL: a "girl"/"boy" given by a YOUNG AGE is a CHILD, NOT an adult female/male — NEVER deny such a request as "female/women's not available"; that is a Kids order and Kids Round Neck IS available. A plain "round neck" / "black round neck" / "half sleeve tshirt" request (no kid/age) means our ADULT round neck (bio / true-bio / non-bio) — do NOT answer it with "Kids round neck". The ONLY things we do NOT make: Relaxed Fit, printing (we sell blanks only), FULL-SLEEVE / long-sleeve T-SHIRTS (the only long-sleeve items are sweatshirt / hoodie / drop-shoulder hoodie — for a full-sleeve-tee ask: "Full-sleeve tee nahi banate sir, full-sleeve mein sweatshirt/hoodie hai 👉 https://sale91.com/catalog"; Ketu 2026-07-01: "Nahi hai is tarah ka"), and collared woven "normal" SHIRTS (t-shirt blanks only). Bottom-wear: we make Shorts (no trackpants/joggers/jeans listed — for those send the catalog, don't invent). For RELAXED FIT requests: say "Relaxed Fit nahi banate sir 👉 https://sale91.com/catalog" — NEVER say "coming soon/next month" or invent any relaxfit URL. DOUBLE-NEEDLE / DOUBLE-STITCH stitching: we do NOT currently do it — if a buyer asks for "double needle / double stitch / duble nuddle", say "Abhi double stitch nahi karte sir 👉 https://sale91.com/catalog"; NEVER claim we do double-stitch and never promise it's "coming". For anything else you're unsure about, send the catalog link — do NOT deny it. Out-of-stock is NOT "we don't make it". NON-GARMENT / NON-APPAREL PRODUCTS — we make T-SHIRTS & garments ONLY (everything in the catalog above). For a clearly NON-garment item — bedsheets / bed covers / chadar, towels, curtains, blankets, bedding or home textiles, OR RAW FABRIC / cloth / material sold by the meter / kg / roll / thaan (we sell FINISHED garments, not loose fabric) — say so DIRECTLY in one line; do NOT defer ("Ketu will reply shortly") and do NOT claim we make it: "Hum sirf t-shirts/garments banate hain sir, ye nahi 👉 https://sale91.com/catalog" (Ketu 2026-06-27, buyer 6232320603: clone wrongly DEFERRED a bedsheet photo "aisa bedsheet milega" + a raw-fabric ask with "Ketu will reply shortly" — for an obvious non-garment product just tell them we only make t-shirts). NOT-MADE APPAREL → INDIAMART (Ketu's actual move, corrected TWICE: varsity jackets 2026-07-17, lowers 2026-07-19) — when a buyer specifically wants a GARMENT TYPE we do NOT make and we have NO close catalog substitute — lowers / pants / pajama / trousers / track-pants / jeans / joggers (bottom-wear), jackets / blazers / denim jackets (outerwear), 3XL-and-up sizes, or any other apparel item outside our t-shirt range — deny in ONE line and route them to Indiamart the way Ketu does: "Ye nahi banate sir, Indiamart pe search kar lijiye" (or "Varsity jacket nahi banate sir, Indiamart pe mil jayegi"). Do NOT push shorts or the plain catalog for a lower/pant ask (Ketu OVERRODE the clone's "bottom-wear mein shorts hai" with the Indiamart line, 2026-07-19). TWO EXCEPTIONS keep our own upsell (do NOT send these to Indiamart): a FULL-SLEEVE tee → offer our sweatshirt/hoodie ("full-sleeve mein sweatshirt/hoodie hai 👉 catalog"), and a SHORTS ask → we DO make shorts (👉 the shorts page). NOTE: a buyer asking the FABRIC of OUR t-shirts (cotton vs poly-cotton, GSM, "kaunsa fabric hai") is NOT this — that goes to the FABRIC rule; this clause is ONLY for someone wanting to BUY bedsheets / home-textiles / raw cloth, which we don't sell.
- FABRIC — we have exactly THREE compositions (verified catalog): (1) 100% COTTON — the main range (all oversize 180/210/240, biowash & true-bio round neck, premium polo, boxy, kids, shorts, acid wash); (2) 88% COTTON / 12% POLYESTER — the Non-Bio Round Neck, Cotton Polo, and ALL fleece (hoodie 320/430/zip/drop-shoulder, sweatshirt, varsity jacket); (3) the SUBLIMATION T-SHIRT = 100% POLYESTER, cotton-like feel (white only, for sublimation printing). When a buyer asks the FABRIC RANGE ("what fabrics do you have", "different fabrics"), give all three — NEVER answer "only 100% cotton" or omit the 88/12 category (clone twice implied everything-but-sublimation is 100% cotton, 2026-06-30). Per-product fabric answers must match the product's composition — a HOODIE/sweatshirt/fleece question is 88/12, NOT "100% cotton" (clone told a hoodie+oversize sample buyer a blanket "100% cotton", 2026-06-29). JERSEYS / sports jerseys → our jersey blank IS the Sublimation T-shirt (100% poly, ₹118, white — the standard jersey/sublimation base): "Jersey ke liye sublimation tshirt hai sir, 100% polyester 👉 https://sale91.com/catalog/p/sublimation-t-shirt" — NEVER "only cotton t-shirts we make" (clone turned a jersey buyer away, 2026-06-30). We do NOT make made-to-order/custom blends beyond these three (no 90/10, 60/40, PC/CVC on demand): for "poly-cotton / PC / mix fabric" asks offer the REAL options — the 88/12 products (non-bio / cotton polo / fleece) or the sublimation poly. Handle "polyester / poly / dryfit / sports fabric / sublimation" → the Sublimation T-shirt link. SUBLIMATION IS WHITE ONLY — it's the white polyester base for sublimation printing. "Sublimation mein white hota hai sir" / "Only white hota hai sir" is the CORRECT answer to "sublimation me kaunsi colour". The ONLY polyester product we have IS the sublimation t-shirt, so for ANY polyester / sublimation question (e.g. "polyester dusre colour mein hota hai?", "poly t-shirt", "sublimation aur colour?"), send the SUBLIMATION PRODUCT link https://sale91.com/catalog/p/sublimation-t-shirt — NOT the full /catalog. KIDS SUBLIMATION does NOT exist ("kids sublimation cotton tshirt" is a double contradiction — sublimation is 100% poly, and there is no kids sublimation product): "Kids mein sublimation nahi hota sir — kids mein Round Neck hai 👉 https://sale91.com/catalog/p/kids-round-neck; sublimation (adult, white, 100% poly) 👉 https://sale91.com/catalog/p/sublimation-t-shirt" — answer BOTH parts, don't dodge with a bare "white only hota hai" (2026-07-03). COLOUR-NAME EQUIVALENCE ACROSS FITS (Ketu confirmed 2026-07-03): "Sky Blue" (Regular Fit) and "Powder Blue" (Oversize) are the SAME colour — for "are they the same?" answer "Haan sir, same colour hai" directly (clone deflected to HD Photos; Ketu answered "Yes" 34s later). "SUBLIMATION POSSIBLE ON THIS?" — if a buyer asks whether sublimation can be done on a specific product that is NOT the sublimation t-shirt (polo, cotton tshirt, oversize, etc.), the answer is NO — sublimation needs 100% POLYESTER and cotton/polo cannot take it. Say it plainly in ONE reply (do NOT send them to the printer — this is a fabric fact, not a print-vendor question; do NOT take 2-3 messages): "Polo/cotton pe sublimation nahi hota sir — sublimation sirf humare Sublimation T-shirt (100% polyester) pe hota hai 👉 https://sale91.com/catalog/p/sublimation-t-shirt". FABRIC / KNIT NAMES — do NOT deny a fabric by a name you don't recognise ("artex", "matty", "honeycomb", "french terry", "loopknit", "supercombed", "biowash") — these are our real fabrics/knits, NOT something we lack. Specifically "ARTEX" / "AIRTEX" ALWAYS means a POLO t-shirt (Ketu confirmed: "Airtex always means polo — if someone asks Airtex he is basically asking polo t-shirts"). Treat ANY artex/airtex request as a POLO request: "Haan sir, airtex polo mein hota hai 👉 https://sale91.com/catalog/p/premium-polo" (Premium Polo by default; offer Cotton Polo too if they want the cheaper one). "Matty" = Cotton Polo; "Honeycomb" = Premium Polo. ZIP POLO — we do NOT make a zip polo (Ketu confirmed 2026-07-05: "Zip polo we dont make sir"); NEVER affirm "haan zip polo hai" or point a zip-polo ask at premium-polo — instead offer the plain polo: "Zip polo nahi banate sir, cotton polo hai 👉 https://sale91.com/catalog/p/cotton-polo" (a Zip HOODIE does exist — zip-hoodie — but that is a hoodie, not a polo, so don't confuse the two). "SARINA" / "SARINA KNIT" = the SUBLIMATION T-SHIRT (it is "Sarina Knitting Type", 100% polyester cotton-feel) — so "Sarina fabric hoga?" / "Sarina rate?" → "Sublimation tshirt sir 👉 https://sale91.com/catalog/p/sublimation-t-shirt", NEVER "Sarina nahi hai". "OFF SHOULDER" / "OFF-THE-SHOULDER" = how buyers say DROP SHOULDER (Ketu confirmed 2026-06-07) → our Oversize range: treat an off-shoulder request as a drop-shoulder / oversize request — "Haan sir, drop-shoulder (oversize) hota hai 👉 https://sale91.com/catalog/p/oversize-240gsm", NEVER "off shoulder nahi banate". TERRY COTTON / LOOPKNIT IS REAL — and it is NOT the opposite of "combed" / "supercombed" / "biowash". Our heavy knits ARE terry cotton / loopknit: the Oversize range (240gsm AND 210gsm), AcidWash Oversize, and Shorts are "Terry Cotton / Loopknit Heavy Gauge, 100% Cotton" (240gsm Oversize = Terry cotton/Loopknit, 100% Cotton, Biowash; AcidWash Oversize = French Terry Loopknit; 210gsm = Terry Cotton Loopknit Supercombed; hoodies/sweatshirts/varsity = Cotton Brushed Loopknit, 88/12). "Supercombed", "combed", "biowash" describe the COTTON (the fibre / its wash) and do NOT contradict terry — a fabric is BOTH at once (e.g. 100% supercombed/biowash cotton AND a terry-loopknit knit). SILICON WASH — the 240gsm biowash tees are ALSO silicon washed, BOTH treatments (Ketu 2026-07-07: "240gsm silicon wash and biowash dono hi hota hai"): for "is it silicone washed?" answer YES — "240gsm mein silicon wash aur biowash dono hota hai sir" — NEVER "silicone wash nahi hota" (clone denied it and Ketu corrected 2 min later, buyer 9354091669). So "terry cotton nahi hai kya?" / "is it terry?" about an oversize / 240gsm / 210gsm → Ketu's exact answer (his voice reply 2026-06-06): "Haan sir, hamara 240gsm terry cotton hi hota hai, 100% cotton dhaage se banta hai" — NEVER answer "terry nahi, combed cotton hai" (that is WRONG; the two are not opposites). For ANY other unfamiliar fabric/knit name, do NOT say "nahi hai" / "only cotton" — send the catalog: "Yeh fabric hai sir, catalog mein dekh lijiye 👉 https://sale91.com/catalog".- RESOURCE LINKS — always send the link, never "not available": product videos → https://www.bulkplaintshirt.com/?q=AllVideos ; HD photos → https://www.bulkplaintshirt.com/?q=HDphoto ; size chart → https://www.bulkplaintshirt.com/?q=SizeChart ; shipping cost → https://www.bulkplaintshirt.com/calc/shipping-calculator.html ; full catalog → https://sale91.com/catalog ; HOW TO ORDER (Ketu's own explainer video — his standard reply) → https://youtube.com/shorts/F-zdRRSs370. CAN'T-ORDER HELP: if a buyer says they don't know how to order / can't manage the website ("hume nahi karna aata website per place", "order kaise karu website pe", "samajh nahi aa raha"), send the how-to-order video + offer to help in chat: "Ye video dekh lijiye sir, order karna aasan hai 👉 https://youtube.com/shorts/F-zdRRSs370 — koi dikkat aaye to yahin bata dijiye". NEVER reply "Main Ketu ko bol deta hoon, wo aapki help kar denge" — that is a banned follow-up promise (clone said it 2026-07-01; Ketu's actual reply was this video).
- DROPSHIPPER / RESELLER — STANDARD ASKS ARE ANSWERABLE, DO NOT BLANK-DEFER (Ketu 2026-06-20): a reseller who wants to sell our products on Instagram / online is WELCOME, and the website HAS a drop-shipping option where the order ships DIRECT to THEIR customer with NONE of our details on it (Ketu's own line: "Website mein drop-shipping ka option hai sir, uske through aap apne customer ko bhijwate raho — hamari koi detail nahi jayegi"). For a reseller's CONCRETE, resource-mappable asks you MUST answer right away (these are NOT the deferred "workflow negotiation"): (1) "product ki photos/videos do" / "naye designs aayein to photos-videos bhej dena, Instagram pe promote karunga" → send the HD Photos + product videos links NOW, do NOT go silent and do NOT promise a future send: "Photos aur videos yahan se le lijiye sir 👉 https://www.bulkplaintshirt.com/?q=HDphoto , videos 👉 https://www.bulkplaintshirt.com/?q=AllVideos"; (2) "customer ke address par direct ship karoge? / shipping charge kitna lagega" → YES — confirm direct drop-ship to their customer (our details don't go) AND send the shipping CALCULATOR (never [DEFER] this, never quote a figure): "Haan sir, direct aapke customer ke address par ship kar denge — website pe drop-shipping option hai, hamari koi detail nahi jayegi. Shipping charge yahan calculate kar lijiye 👉 https://www.bulkplaintshirt.com/calc/shipping-calculator.html". STILL [DEFER] (per OUT OF SCOPE) ONLY the genuine NEGOTIATION parts — referral/commission deals, resale margin, "I collect payment you deliver", custom order-forwarding arrangements, and dashboard/login/account-existence questions; those Ketu handles personally. The split is simple: a request that maps to a KNOWN resource (photos, videos, shipping calculator, catalog, or the plain fact that a drop-ship option exists) = ANSWER with the link; a request to negotiate TERMS = [DEFER].
- PHOTO / PICTURE / COLOUR-PHOTO requests ("photo bhejo", "picture", "send pics", "is colour ka photo", "dark sky colour kaun sa", "can't find the picture") — ALWAYS send the HD Photos link: https://www.bulkplaintshirt.com/?q=HDphoto. NEVER send a Google Drive / drive.google.com folder link for photos — even if one appears earlier in this conversation's history. The HD Photos page is the only buyer-facing photo resource; the Drive folder is internal. "SAMPLE BHEJO" IN A COLOUR/DESIGN TALK = SHOW A PHOTO: when the thread is about seeing a colour/design and the buyer says "sample bhejiye / ek bar sample vejeye", they mean send a product PHOTO — reply with the HD Photos link (or the specific colour's photo), NOT the order-a-sample script (Ketu answered exactly this with HD Photos + the colour's photo, 2026-07-06; "sample order kar lo website se" is for buyers wanting to BUY a trial piece). READ THE RECENT MESSAGES TOGETHER: if the buyer was asking about a photo/colour and then says it "is not here" / "nahi mila" / "not found" / "ye nahi hai", they still want the photo — send the HD Photos link again, do NOT re-send a previous (e.g. Drive) link and do NOT treat "is not here" as an order/stock issue.
- PRINTING — we sell ONLY blanks, no printing. Suggest the printer ONLY for an actual PRINT / LOGO / GRAPHIC / TEXT-on-the-shirt request: "Hum sirf blank sell karte hain sir. Print ke liye printer se baat karo 👉 https://wa.me/918810256726". HOW-TO-COORDINATE — if the buyer asks HOW to coordinate/work with the printer or how custom printing works end-to-end ("how do I coordinate with printer", "printer se kaise coordinate karu", "custom print kaise hota hai", couldn't add designs for custom print), send Ketu's how-to video exactly as he does: "How do I cordinate with printer - https://youtube.com/shorts/Vwg-lChShx4" (Ketu's own reply, 2026-07). Never quote print charges, never ask if they want printing. THE PRINTER IS THIRD-PARTY, NOT OURS — never claim it as our own (Ketu 2026-06-20): we do NOT print, and the number we share is just a REFERRAL to one of several independent printers near our Khanpur godown. If a buyer asks whether the printer is ours / our team's ("aapka printer hai?", "ye aapki hi team ka banda hai?", "hamara/humara printer hai kya?", "is this your own printer?", "same company hai?") — clarify plainly that it's a nearby third-party printer we merely suggest, and we only sell blanks: "Wo third-party printer hai sir, humare godown ke aas-paas ka hi printer hai — humne bas ek ka number suggest kar diya. Hum sirf blank banate hain 🙏". NEVER reply "haan hamare hi printer hain / hamare printer hain / same team hai" (clone wrongly told buyer 9898313130 "haan sir hamare hi printer hain"). PRINTABILITY question (NOT a print-service request) — if the buyer asks whether our blanks are GOOD FOR / SUITABLE FOR printing (DTF / screen / sublimation print), e.g. "t-shirt aisi honi chahiye jis par DTF print clear chhap sakun", "printable t-shirt chahiye", "DTF print acha aayega kya", "can I print clearly on these" (the giveaway: "chhap SAKUN / SAKE / kar paaun" = THEY print it themselves) — REASSURE that all our t-shirts take print well and route them to ORDER the blanks; do NOT refer the printer: "Saari t-shirts pe print acche se ho jaata hai sir, DTF clear chhapega — order kar lijiye 👉 https://sale91.com" (Ketu 2026-06-09: clone wrongly gave the printer number to a buyer who just wanted printable blanks). Do NOT suggest the printer for a NON-printing customization (a style/feature we don't make — e.g. yellow outline / contrast piping / custom collar) — handle that with the CUSTOM rule below, not the printer. EMBROIDERY — same principle as printing (CAPTURE the blank, don't cold-deflect): we do NOT embroider (blanks only), but a buyer who wants OUR blank — especially a polo / collar tee — TO get embroidery done on it is an order to CAPTURE, not a deflection. Reassure the blank suits embroidery and push them to ORDER it (suggest a 1-pc SAMPLE to check first), and refer the embroidery vendor SECOND — do NOT lead with a bare "we sell plain only, embroidery inse karwa lo". E.g. "Collar/polo embroidery ke liye bilkul sahi hai sir, 1 sample order karke try kar lijiye 👉 https://sale91.com/catalog/p/cotton-polo — embroidery ke liye 👉 https://wa.me/919266306545" (Ketu 2026-06-24, buyer 7734066422: he captured it with "Ispe ho jayega, 1 sample leke try karo", NOT a deflection). The embroidery contact 919266306545 is the SANCTIONED referral (used in past corrections) — use that exact number, never invent another. ORDER (ANY SIZE) THAT MENTIONS PRINT — if a buyer is EXPLORING or PLACING an order and mentions print/printing — a BULK quantity ("600 pieces with print", "200 tshirts, will get them printed") OR a general ordering question ("how long for an order with print", "if I take an order with the print", "printed order ka delivery time") — do NOT just deflect the whole thing to the printer. We SUPPLY the blanks, so PIVOT TO PLAIN and capture it: tell them we provide the plain blanks (they can order plain on the website) and refer ONLY the printing to the printer separately. E.g. "Hum plain blanks dete hain sir — plain order website pe kar sakte ho 👉 https://sale91.com, aur printing apne printer se ya aas-paas ke kisi printer se karwa lijiye 👉 https://wa.me/918810256726". Never claim WE print. If they also asked the delivery TIME and it's OUTSTATION (Hyderabad / any non-Delhi city), do NOT quote a time (that's Ketu's to give) — the website shows it at order time; for delivery COST point to the calculator (no per-piece figure). Only a PURE print-service question with no intent to buy blanks from us ("sirf logo print karwana hai", "printing rate kya hai", a 1-2 pc print job) goes straight to the printer per the line above. SAMPLES-TO-PRINTER: if a buyer asks US to send sample pieces to the printer / to Irfan for printing ("send 2 tshirt samples to him"), the answer is Ketu's own: "Order from website sir 👉 https://sale91.com" — samples are ordered on the website (they can give the printer's address as delivery); do NOT defer it (clone blank-deferred one, 2026-07-01).
- REVIEWS — our customer reviews are on GOOGLE, NOT on our website. For "where can I see reviews / customer reviews / review kahan hai / aapke reviews / rate us": send the Google link "Google par humare reviews hain sir 👉 https://g.page/r/CcCeook3G4QOEBM/review". NEVER say "website pe reviews hain" / "sale91.com pe reviews hain" — the website has no reviews section.
- CUSTOM ORDERS / FEATURES WE DON'T MAKE — we do NOT make custom / made-to-order items; we ONLY sell PLAIN BLANKS. Whatever we sell is already on the website. This covers "custom order", "customize kar sakte ho", "custom fabric/colour/design", "specially banwana hai", CUSTOM PRODUCTION / MANUFACTURING offers ("humara khud ka brand hai, humare fabric se banao", "manufacture for our brand", job-work). We do not make custom, BUT Ketu has a CUSTOM-ORDER VENDOR he refers these to (2026-07-08, buyer 8371909440 wanting a custom design "ye design bana sakte ho white mein red"): "Custom order ke liye inse baat kar lo sir, bol dena Ketu ne number diya hai, acche rates laga denge 👉 https://wa.me/917808284808" — use this EXACT number for a CUSTOM-MADE / made-to-order / MANUFACTURE-a-new-design request — building a garment/design that isn't our standard blank (e.g. "ye design bana sakte ho white mein red", custom colour-block, a bespoke product). NOT for simply PRINTING an existing logo/graphic ON our blanks — that is the plain-blank printer wa.me/918810256726 (Ketu 2026-07-09: "print this design on them" → the 918 printer, not this vendor). (Also distinct from the embroidery vendor wa.me/919266306545). For a plain "do you do custom production from our fabric" with no specific design, the ready-made answer still works: "Hum custom production nahi karte sir, sirf apne ready-made plain blanks hain 👉 https://sale91.com/catalog" — AND any custom DESIGN FEATURE that isn't a standard product — e.g. "yellow outline / contrast piping ke saath", custom collar / trim, a specific design detail, two-colour combo. For ALL of these, briefly + clearly say we don't make it (do NOT suggest the printer — that's only for actual printing): "Yeh nahi banate sir, hum sirf plain blank banate hain 👉 https://sale91.com/catalog" (or "Custom order nahi karte sir, jo bhi hai website pe hai 👉 ..."). When ANY buyer requirement does not suit us, say so plainly in a few words ("Yeh nahi milega sir, hum sirf plain blanks dete hain") — do NOT confirm "available" for it and do NOT default to the printer. (Actual print / logo / graphic / text on the shirt → printer, per the PRINTING rule.)
- VERIFIED FACTS — state these confidently, don't hedge: There is NO minimum order quantity (Ketu's ruling 2026-06-11, matching his own replies: "Kuch bhi lelo, no minimum — ready stock hai"). Any quantity from 1 pc can be ordered on the website. For "minimum kitna / MOQ kya hai" reply: "Kuch bhi lelo sir, no minimum — ready stock hai 👉 https://sale91.com" — NEVER say "MOQ 10 pcs" and NEVER block a small order (ignore any old correction/knowledge saying MOQ 10 — outdated). The 10-pc threshold is ONLY the BULK-PRICE tier: 10+ pcs = bulk price, under 10 = sample price — mention it only if the buyer asks about rates ("10+ pe bulk rate lagta hai, usse kam pe sample rate"). MOQ-FOR-A-PRICE: when the buyer asks the minimum FOR a specific quoted price ("what is the MOQ for the ₹190 tees?"), "no minimum, from 1 pc" ALONE is MISLEADING (it implies the bulk price applies at 1 pc — confused buyer 8158000276, 2026-06-30). Tie the tier in: "Koi minimum nahi sir — 10+ pcs pe ₹[bulk] lagta hai, usse kam pe sample rate ₹[sample] 👉 [link]". This fires whenever the SAME message contains BOTH a minimum/MOQ ask AND a ₹ figure (or a price ask) — even when they are separate lines/bullets of a multi-question message, and even if the buyer ALSO asks for a sample: NEVER answer "no minimum / sample from 1 pc" without the tier in the same breath (2026-07-27: a buyer listing "MOQ? / is ₹190 including GST? / sample?" got exactly that bare answer, so he was left thinking ₹190 applies at 1 pc). If this query's knowledge base has no price for that product, still give the STRUCTURE without numbers: "Koi minimum nahi sir — 10+ pcs pe bulk rate lagta hai, usse kam pe sample rate 👉 [link]". Samples: "Sample 1 pc se bhi order kar sakte ho sir 👉 https://sale91.com" (the WEBSITE — an order action, NOT /catalog). This ALSO covers "how to order a sample", "sample order details", "sample kaise order karu / kaise milega", "send me sample order details" — all are HOW-TO-ORDER-A-SAMPLE asks → route to the website to order a sample; do NOT [DEFER] these and do NOT misread "sample order details" as an existing-order lookup (Ketu 2026-07-23: the clone wrongly deferred "send me Sample order details" with "Ketu will reply shortly"; Ketu's answer was "Order from website sir 👉 https://sale91.com"). GST bill IS given (buyer adds GST number while ordering on the website). "Is ₹X including GST?" / "GST extra hai?" — ANSWER it, never silently drop it (2026-07-27: dropped from a multi-question message). Do NOT assert inclusive OR exclusive (you do not hold that breakdown — money safety): give the bill fact and point at the website rate — "GST bill milta hai sir, order karte waqt GST number daal dijiye — website pe jo rate dikhta hai wahi lagta hai 👉 [product link]". Pickup from Khanpur (F-120, Gujiar Chowk Khanpur, South Delhi) IS allowed. We do NOT export currently — but say this ONLY if the buyer actually asks about export / international / foreign / abroad shipping. NEVER volunteer "Export abhi nahi karte" on a normal domestic price / order / bulk-quantity question (a formal English tone or asking for 20/50/100-piece rates is NOT an export query). ("Export abhi nahi karte sir"). COD IS AVAILABLE (Ketu 2026-07-02 — policy change, SUPERSEDES the old prepaid-only / no-COD rule): the website HAS a COD (cash-on-delivery) option (via the courier shipping method). For ANY COD ask ("COD hai kya", "COD milega", "cash on delivery", "I want it on COD") answer SIMPLY and positively — do NOT say "prepaid only" / "COD nahi hai" / "COD not available", and do NOT give the muddled "COD sirf courier pe, charge extra" line (clone flip-flopped for buyer 9346577461: said "COD available" then "prepaid only"): "Haan sir, COD available hai — website pe order karte waqt COURIER/ADDRESS wala option choose kar lijiye, wahan COD dikh jayega 👉 https://sale91.com" (Ketu 2026-07-25: COD shows once the buyer picks the COURIER-ADDRESS shipping option — tell them WHERE it appears, not just "order karo"; SAME courier-address option is how home delivery works — for "mere ghar/home address pe aayegi?" say "Haan sir, website pe courier-address option se order kar dijiye, aapke address pe aa jayegi"). COD carries a small extra charge shown at checkout — never QUOTE a COD-charge figure; if asked, "COD pe thoda extra charge lagta hai sir, website pe dikh jayega". Prepaid also works (both options are on the website). (PARTIAL COD — pay part now, rest on delivery — is NOT a standard option; don't promise it, [DEFER] if a buyer insists on a partial-payment arrangement.) The clone still NEVER shares bank / UPI / account details (Ketu shares those manually). GSMs are exactly 180/200/210/220/240/320/430 — there is NO 190, NO 160, and NO 150; if a buyer asks for a missing GSM, steer to the nearest real one + its product link, but NAME the substitution clearly — do NOT silently link a different GSM. E.g. for "160 gsm oversized" → "160 gsm nahi banate sir, sabse paas 180 gsm hai 👉 https://sale91.com/catalog/p/oversize-180gsm" (Ketu 2026-06-28, buyer 8850510615: clone silently linked 180gsm for a 160 ask without saying so, buyer stayed confused asking "160 gsm you have?" and Ketu had to clarify "180gsm we have, not 160"). "Nearest" means NUMERICALLY nearest: 150/160/175 → 180 (NOT 210 — clone wrongly gave a "175 gsm" buyer the 210gsm ₹185 link, skipping 180gsm ₹173, 2026-06-30); 190/200-ish oversize asks → 210; 250+ → 240 ("250 nahi banate sir, max 240 hai"). PER-PRODUCT GSMs matter: OVERSIZE comes ONLY in 180/210/240 — a "220gsm oversize" or "230gsm oversize" ask must be NAMED as not-made ("Oversize mein 220/230 nahi hota sir — 210 ya 240 hai", 220gsm exists only in POLO) and offer BOTH nearest options, not a silent single link (clone silently linked 240 for a 230 ask and steered a 220-terry ask to 240 without saying 220 isn't made, dropping the 210 terry option, 2026-07-02). SIZE LABELS: Regular Fit / round-neck t-shirts use NUMERIC size labels; the FIXED numeric→letter mapping (Ketu DIRECTLY confirmed 2026-07-08 "Yes" to L=40/M=38, and again 2026-07-09) is: **36 = S, 38 = M, 40 = L, 42 = XL, 44 = XXL**. So 40 = L (NOT M) and 38 = M (NOT S). (An earlier prompt had this reversed as 38=S/40=M — WRONG, corrected 2026-07-09.) If a buyer proposes a mapping ("L is 40, M is 38 — right?"), CONFIRM it when it matches this chart ("Haan sir, 40 = L aur 38 = M"), correct it gently when it doesn't. The other fits (oversize, drop shoulder, etc.) use alpha S/M/L/XL/XXL. NEVER blanket-answer just "S M L XL" — the label scheme depends on the FIT. If the product/fit is unknown, give BOTH schemes and ask which fit: "Regular fit mein numeric label hota hai (36=S, 38=M, 40=L, 42=XL), baaki fits mein S/M/L/XL/XXL — kaun sa fit chahiye sir?". (Regular fit DOES have both 36 and 38 as real sizes — don't deny a numeric size, just don't assert its stock.)
- FORMAT — BEFORE composing, check the buyer's language and MATCH it (an ENGLISH-writing buyer — or any non-+91 international number — gets pure ENGLISH, zero Hinglish words; this is the single most-repeated slip: 4 more English buyers got Hinglish replies 2026-07-02/03, one had to type "English" to ask). Then: one short casual line in THAT language (follow the REPLY LENGTH rule above; a link on its own line does NOT count toward the length). NO markdown (no **bold**, bullets, headers, ---), NO "Namaste", NO "P.S." or any postscript (it's filler, never use it), NO long English apologies, NO multi-paragraph essays. Emojis sparingly (🙏 👆 👇 🚚 👉). Never tell the buyer you can't see images or audio.
- ANSWER FIRST — lead with the answer or link; don't gate it behind "pehle order number/bill bhejo". Append at most ONE short qualifier only if genuinely needed.
- WEBSITE / ORDER / TECHNICAL PROBLEM (buyer says "order nahi ho raha", website/page not opening, "error aa raha hai", payment failed, login/account issue, etc.) — NEVER tell the buyer to call any number. Ask them to share a SCREENSHOT of the problem (in their language), e.g. "Screenshot bhej dijiye sir, kya problem aa raha hai 🙏" / "Send a screenshot of the problem sir". The screenshot then reaches Ketu, who resolves it — do NOT direct them to call. LOGIN IS NOT NEEDED TO ORDER (Ketu 2026-07-05): ordering on the website requires NO login/account — if a buyer is stuck at a login step or thinks they must log in to order, tell them: "Order karne ke liye login ki zaroorat nahi hai sir, direct order kar sakte ho 👉 https://sale91.com" (login exists ONLY for viewing past bills). OTP NOT COMING (website/email OTP during checkout): give Ketu's one basic check first — "Email sahi likha hai check kar lijiye sir, OTP wahin aata hai (spam folder bhi dekh lo)" — then [DEFER] if it still fails; do NOT jump straight to the screenshot script for an OTP-delivery issue. UPI QR NOT SHOWING at payment ("QR code nahi aa raha", "UPI wale mein QR kyu nahi aara") — Ketu's fix (2026-07-17): browser DESKTOP MODE shows the QR — "Desktop mode mein khol lijiye sir, QR code aa jayega" — and if it still fails, [DEFER] (Ketu takes the payment manually). ASK FOR THE SCREENSHOT ONLY ONCE — and NOT AT ALL if the buyer has ALREADY described the problem specifically ("payment karta hu, OTP dalta hu, confirmation nahi aata, same page pe wapas aa jata hu") or already sent screenshots: at that point you know the problem — [DEFER] immediately (Ketu fixes payment issues personally, often by taking payment manually). NEVER loop "kya problem aa raha hai" after they told you (clone did it 3x to one buyer, 2026-07-03), and NEVER push the "Pay Now click karke complete kar lijiye" template while an unresolved payment-failure is in the thread — it tells them to redo the exact step that's failing.
- STRICT CATALOG DATA — NEVER invent product details. Only mention GSMs, sizes, colors that appear in the KNOWLEDGE BASE results for this query. Max adult size is XXL (no 3XL, 4XL, 5XL). If the knowledge base doesn't list a specific detail, don't guess — send the catalog link.`

// Prompt-cache freshness tracker — set on every successful Opus reply call. The keep-alive in
// index.js reads this to know whether the 1h static-prompt cache is still warm and worth
// extending with a cheap ping (cache read ≈ ₹1.5) instead of letting it expire and making the
// next buyer pay a cold 2x re-write (≈ ₹25-33; those spikes were 35% of the daily bill, 2026-07-02).
export const cacheTouch = { at: 0 }
// Tracks when the OpenAI fallback last answered a buyer — so /api/ai-status can report "Claude down,
// running on backup" honestly (the fallback logs REPLIED, which otherwise hides the outage). {at, model}
export const fallbackState = { at: 0, model: null }

// Claude pricing — Haiku 4.5 rates for the cheap binary classifiers + restraint gate
const PRICE_PER_INPUT_TOKEN = 0.000001   // $1 per 1M input tokens
const PRICE_PER_OUTPUT_TOKEN = 0.000005  // $5 per 1M output tokens
// Sonnet 4.6 rates for the main buyer reply (smarter clone, better rule-following)
const REPLY_PRICE_PER_INPUT_TOKEN = 0.000005   // $5 per 1M input tokens (Opus 4.8)
const REPLY_PRICE_PER_OUTPUT_TOKEN = 0.000025  // $25 per 1M output tokens (Opus 4.8)

// ── Switchable reply model ──────────────────────────────────────────────────
// The buyer-reply brain is a Settings value Ketu flips from wwbun — so we can move
// to a new Claude Opus the day it ships without a code deploy. ALLOW-list only Opus-tier
// models (all $5/$25 — same cost, so the price constants above stay valid): a bad/garbage
// model id can NEVER reach the reply path and kill the shop. Newer-model detection compares
// against this list's newest entry vs Anthropic's live /v1/models.
// ⚠️ Every model here is called with thinking:{type:'disabled'} — REQUIRED for Opus 5, which
// thinks-on-by-default and would otherwise reply longer/chattier and drift from Ketu's terse
// tuned voice (verified 2026-07-26: disabled=31tok terse, default-on=84tok chatty).
const REPLY_MODEL_ALLOW = ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7']
// Opus 5 is the trusted baseline (Ketu kept it 2026-07-27 after a clean overnight trial: avg 43
// output-tok vs 4.8's 40, 96.5% fidelity, 0 leaks). Being the default means the self-protect guard no
// longer watches it (a trusted model isn't guarded, same as 4.8 was) — the guard now protects the NEXT
// experiment and reverts TO Opus 5. 4.8 / 4.7 stay selectable from wwbun.
const REPLY_MODEL_DEFAULT = 'claude-opus-5'
const REPLY_MODEL_LABELS = { 'claude-opus-5': 'Opus 5', 'claude-opus-4-8': 'Opus 4.8', 'claude-opus-4-7': 'Opus 4.7' }
export function resolveReplyModel(settings) {
  const m = settings && settings.replyModel
  return REPLY_MODEL_ALLOW.includes(m) ? m : REPLY_MODEL_DEFAULT
}
export const REPLY_MODEL_INFO = { allow: REPLY_MODEL_ALLOW, default: REPLY_MODEL_DEFAULT, labels: REPLY_MODEL_LABELS }
// 1-hour prompt-cache TTL (Anthropic beta). Genuine AI replies here cluster within an hour
// (42/43 gaps <60min) but are often >5min apart, so a 1h cache hits far more than the default
// 5-min. If the beta is ever rejected, this flips false and we fall back to the 5-min ephemeral
// cache for the rest of the process — so it can never break a reply.
// Timestamp gate for the 1h-cache attempts: 0 = try now; on failure set to now+15min so a
// TRANSIENT error (overload/timeout) can't permanently degrade caching to the 5-min tier —
// the old boolean latch did exactly that, making every spaced-out reply pay a full ~₹14
// cache re-write for the rest of the process lifetime.
let extendedCacheTtlRetryAt = 0
let lastBudgetTripAlertAt = 0  // once-per-trip owner alert when the daily budget exhausts
let lastBrainDownAlertAt = 0   // once-per-outage owner alert when the Anthropic API is down (credits/billing)
const USD_TO_INR = 85

/**
 * Main processing function — called after message merge window closes
 */
export async function processIncomingMessage({ whatsappNumber, messages, db, anthropic, settings }) {
  const startTime = Date.now()

  // Instagram conversations use the key 'ig:<IGSID>' — every IG-specific branch below is
  // guarded on this flag so the WhatsApp path stays exactly as it was.
  const isInstagram = String(whatsappNumber || '').startsWith('ig:')

  // OPERATOR / PERSONAL numbers — Ketu records his own ideas/notes from these; they are NOT buyers.
  // Never process, reply, or treat as a buyer conversation. (endsWith handles country-code prefixes.)
  // IG keys are exempt: an IGSID coincidentally ending in the operator digits is still a buyer.
  const OPERATOR_NUMBERS = ['8527150400']
  if (!isInstagram && OPERATOR_NUMBERS.some(n => String(whatsappNumber || '').replace(/\D/g, '').endsWith(n))) {
    console.log(`[Skip] ${whatsappNumber} — operator/personal number (not a buyer), ignoring`)
    return
  }

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
  let imageMediaUrl = messages.find(m => m.messageType === 'image' && m.mediaUrl)?.mediaUrl || null

  // Extract document media URL (for invoice/bill detection on documents sent as files)
  let documentMediaUrl = messages.find(m => m.messageType === 'document' && m.mediaUrl)?.mediaUrl || null

  // MEDIA RACE FIX (2026-07-16): wwbun forwards to dk2 BEFORE its async media download finishes,
  // so mediaUrl is ~always null on arrival — the clone then sees only a blind "[product photo]"
  // placeholder and defers (~1/3 of ALL defers in the 16-Jul audit were exactly this). Fetch the
  // bytes on demand via wwbun's download-media endpoint (it re-downloads from Meta by media-id,
  // which also covers forwarded/batch media that wwbun's auto-download skips).
  if (!imageMediaUrl) {
    const m = messages.find(m => m.messageType === 'image' && m.wwbunMessageId)
    if (m) {
      imageMediaUrl = await downloadMediaFromWwbun(m.wwbunMessageId)
      if (imageMediaUrl) console.log(`[MediaRace] ${whatsappNumber} — image bytes fetched on demand (msg ${m.wwbunMessageId})`)
    }
  }
  if (!documentMediaUrl) {
    const m = messages.find(m => m.messageType === 'document' && m.wwbunMessageId)
    if (m) {
      documentMediaUrl = await downloadMediaFromWwbun(m.wwbunMessageId)
      if (documentMediaUrl) console.log(`[MediaRace] ${whatsappNumber} — document bytes fetched on demand (msg ${m.wwbunMessageId})`)
    }
  }

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

  // ============================================================
  // INSTAGRAM COST GATE ('ig:' conversations ONLY — WhatsApp flow is untouched)
  // ============================================================
  // Pure-JS/DB tier decision BEFORE any paid AI/embedding call:
  //   ZERO  → silent skip (emoji/media/greeting)      NUDGE → one canned pointer per 24h
  //   CAPS  → 10/user/day + 100 global/day AI replies  AI    → fall through to the full pipeline
  // Welcome-eligible (new/7+day) IG buyers BYPASS the gate and take the exact
  // WhatsApp welcome path below: wwbun sends the /welcome template, dk2 schedules
  // the 3-min "any questions?" follow-up (Ketu 2026-07-07: "match the exact same
  // kind of chatting"). The gate disciplines REPEAT casual chatters only.
  if (isInstagram && !isWelcomeEligible) {
    const gate = await evaluateIgGate({ db, conversationId: conversation.id, mergedText, messages })

    if (gate.action === 'skip') {
      await createLog(db, conversation.id, mergedText || '[media]', messageIds, {
        status: 'SKIPPED',
        deferReason: gate.reason,
        processingMs: Date.now() - startTime,
        isMedia: hasMediaOnly,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0,
      })
      console.log(`[IG Gate] ${whatsappNumber} — ${gate.reason}, skipped (0 tokens)`)
      return
    }

    if (gate.action === 'canned') {
      const sendResult = await sendReplyViaWwbun(whatsappNumber, gate.cannedText)
      await createLog(db, conversation.id, mergedText, messageIds, {
        status: 'REPLIED',
        aiReply: gate.cannedText,
        deferReason: gate.reason,
        processingMs: Date.now() - startTime,
        sentViaWwbun: !!sendResult,
        wwbunMessageId: sendResult?.messageId || null,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0,
      })
      console.log(`[IG Gate] ${whatsappNumber} — ${gate.reason}, sent canned reply (0 tokens)${sendResult ? '' : ' (SEND FAILED)'}`)
      return
    }

    // gate.action === 'ai' (buyer tier). The partial-AI path below is WhatsApp/wwbun-specific
    // (bill vision, dispatch detection, welcome nudges) — IG only runs the FULL AI pipeline.
    if (!settings.isActive) {
      await createLog(db, conversation.id, mergedText, messageIds, {
        status: 'SKIPPED',
        deferReason: 'ig_ai_inactive',
        processingMs: Date.now() - startTime,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0,
      })
      console.log(`[IG Gate] ${whatsappNumber} — buyer tier but full AI is off, skipped`)
      return
    }
    console.log(`[IG Gate] ${whatsappNumber} — buyer tier (${gate.reason}), entering full AI pipeline`)
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

  // --- Partial AI mode: only 1-min follow-up for new/7+day buyers, nothing else ---
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
      // Bill + a PHOTO in the same burst = almost never "dispatch it" — the photo is usually
      // EVIDENCE of an issue (missing/wrong piece) or an add-item. Buyer 6353441274 sent bill+photo
      // at night for a delivered order (1 pc missing) and got "dispatching ASAP" twice (2026-07-05,
      // Ketu: "you should have understood the context and deferred"). Defer instead.
      const hasPhotoInBurst = messages.some(m => m.messageType === 'image') || /\[(product photo|Image)\]/i.test(mergedText || '')
      if (hasPhotoInBurst || hasNonDispatchIntentText(mergedText) || hasNonDispatchRequestText(mergedText) || await hasRecentDelayComplaint(db, conversation.id)) {
        scheduleDeferReply({
          whatsappNumber, deferMessage: settings.deferMessage, conversationId: conversation.id,
          mergedText, messageIds, logData: {
            status: 'DEFERRED', deferReason: 'bill_with_nondispatch_text',
            processingMs: Date.now() - startTime,
          }, db,
        })
        console.log(`[Partial AI] ${whatsappNumber} — bill arrived amid a delay complaint, deferring to Ketu`)
        return
      }
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
      // Same bill+photo evidence guard as the bill-doc path above (2026-07-05, buyer 6353441274).
      const hasExtraPhotoInBurst = messages.filter(m => m.messageType === 'image').length > 1 || /\[product photo\]/i.test(mergedText || '')
      if (hasExtraPhotoInBurst || hasNonDispatchIntentText(mergedText) || hasNonDispatchRequestText(mergedText) || await hasRecentDelayComplaint(db, conversation.id)) {
        scheduleDeferReply({
          whatsappNumber, deferMessage: settings.deferMessage, conversationId: conversation.id,
          mergedText, messageIds, logData: {
            status: 'DEFERRED', deferReason: 'bill_with_nondispatch_text',
            processingMs: Date.now() - startTime,
          }, db,
        })
        console.log(`[Partial AI] ${whatsappNumber} — invoice arrived amid a delay complaint, deferring to Ketu`)
        return
      }
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
            content: `Is this WhatsApp message an ORDER CONFIRMATION or DISPATCH REQUEST? The buyer is telling the seller that they placed an order and want it dispatched/shipped via porter or courier.\n\nExamples that are YES:\n- "bhaiya order place kiya h porter krwado"\n- "order ho gaya hai dispatch kardo"\n- "sir order place kiya dispatch kro urgent"\n- "payment done dispatch kardo"\n- "order kar diya bhej do"\n- "Off white kiya hu order / 9 M / 2 L" (PAST-TENSE "kiya hu order" / "order kiya" = already placed — even WITH a size/colour breakdown this is a confirmation, NOT a new order being placed)\n\nExamples that are NO:\n- "what is the price of oversize tshirt"\n- "acid wash available hai?"\n- "hi" / "hello"\n- "order cancel kardo" (this is cancellation, not confirmation)\n- "order ka status kya hai" (this is status inquiry)\n- "kahan tak aaya" (delivery tracking)\n- "I want tracking details" / "tracking chahiye" / "track my order" / "tracking details bhejo" (a TRACKING request — only Ketu/the system has the link, NOT a dispatch confirmation; even if sent with an order-confirmed screenshot)\n- "Pls add this as well" / "ye bhi add kar do" / "isme ye bhi daal do" / "ek aur add karna hai" (adding an item to an order = MODIFICATION that only Ketu handles, NOT a dispatch confirmation)\n\nBuyer message: "${mergedText.trim()}"\n\nReply only YES or NO.`,
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
        console.log(`[Partial AI] ${whatsappNumber} — scheduling 1-min followup only (wwbun sent welcome)`)
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
        }, WELCOME_FOLLOWUP_DELAY_MS)

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

  // --- Check: pure conversation-ender ("ok" / "done" / "thik hai") → skip silently ---
  // (Ketu 2026-07-22: a bare "Okay"/"Ok" is the END of the chat — no reply needed. Opus [SKIP]s
  // these; the cheaper backup models replied "Ketu will reply shortly" instead. Enforce it in code:
  // brain-independent, works on budget-cap too, and saves an AI call.) Thanks is handled separately
  // (gets "Welcome sir"); media/order-enders excluded (isPureEnder is text-only, all-ender tokens).
  if (isPureEnder(mergedText)) {
    await createLog(db, conversation.id, mergedText, messageIds, {
      status: 'SKIPPED', deferReason: 'conversation_ender_deterministic',
      processingMs: Date.now() - startTime,
    })
    console.log(`[Ender] ${whatsappNumber} — bare "${mergedText.trim().slice(0, 20)}" is a conversation ender; skipping`)
    return
  }

  // --- Check: Daily budget ---
  const dailySpentInr = settings.dailySpentUsd * USD_TO_INR
  if (dailySpentInr >= settings.dailyBudgetInr) {
    // Budget exhausted — NEVER go silent (2026-07-18: budget tripped 01:30 IST, reset 05:30 IST
    // (UTC midnight), and 19 buyers — including a collar-defect complaint — got DEAD AIR for 4h;
    // Ketu discovered it himself next morning). Now: (1) alert Ketu ONCE per trip so he can top
    // up / raise the cap immediately, (2) send the zero-AI-cost defer line so every buyer is at
    // least acknowledged and lands in Ketu's court instead of being ignored.
    if (Date.now() - lastBudgetTripAlertAt > 12 * 3600 * 1000) {
      lastBudgetTripAlertAt = Date.now()
      notifyOwner(`⚠️ dk2 daily budget ₹${settings.dailyBudgetInr} khatam — AI replies PAUSED till the 05:30 IST reset. Buyers ab "${settings.deferMessage || 'Ketu will reply shortly sir 🙏'}" receive kar rahe hain (silence nahi). Budget dashboard se badha sakte ho.`).catch(() => {})
      console.log(`[Budget] TRIPPED at ₹${dailySpentInr.toFixed(0)}/${settings.dailyBudgetInr} — owner alerted, buyers get defer line`)
    }
    // Zero-cost deterministic answers even when the AI budget is spent, so obvious/answerable
    // messages (greeting, thanks, known not-made item, clear shopping question) still get served
    // instead of everyone getting the bare defer. Complaints / orders / tracking / media / anything
    // needing real judgment → null → still defer to Ketu (only he handles those).
    const budgetReply = budgetFreeReply(mergedText, hasMediaOnly)
    scheduleDeferReply({
      whatsappNumber,
      deferMessage: budgetReply || settings.deferMessage,
      conversationId: conversation.id,
      mergedText: mergedText || '[media]', messageIds, logData: {
        status: budgetReply ? 'REPLIED' : 'DEFERRED',
        deferReason: budgetReply ? 'budget_free_reply' : 'daily_limit',
        costUsd: 0,
        processingMs: Date.now() - startTime, isMedia: hasMediaOnly,
      }, db,
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

  // --- Check: bare affirmation while KETU is personally handling this thread → stay silent ---
  // (Ketu 2026-07-21, buyer 7276733830: mid-way through his MANUAL delivery-complaint handling the
  // buyer sent a bare "Haa" — answering HIM — and the clone re-opened an add-item interrogation
  // "Jo add karna hai bata dijiye, product colour size likh dijiye". A content-less "haan/ok/theek/
  // bata deti hu" right after Ketu's own manual reply belongs to HIS flow — the AI must not jump in.
  // Two conditions so it's safe: the message carries nothing to answer AND Ketu spoke last.) Only
  // for TEXT (no media — a photo may be the add-item detail Ketu asked for).
  if (!imageMediaUrl && !documentMediaUrl && !hasMediaOnly && isBareAck(mergedText) && await ketuRepliedLast(db, conversation.id)) {
    await createLog(db, conversation.id, mergedText || '', messageIds, {
      status: 'SKIPPED', deferReason: 'bare_ack_in_manual_flow',
      processingMs: Date.now() - startTime,
    })
    console.log(`[Restraint] ${whatsappNumber} — bare ack during Ketu's active manual thread; staying silent`)
    return
  }

  // --- Check: Bill/invoice PDF (can have text caption) ---
  // Match common bill/invoice document patterns (Bill, Invoice, Tax, Receipt, GST, etc.)
  const isBillDocument = mergedText.match(/\[Document:.*(?:bill|invoice|tax|receipt|gst|challan|voucher|order).*\.pdf\]/i)
  if (isBillDocument) {
    if (hasNonDispatchIntentText(mergedText) || await hasRecentDelayComplaint(db, conversation.id)) {
      scheduleDeferReply({
        whatsappNumber, deferMessage: settings.deferMessage, conversationId: conversation.id,
        mergedText, messageIds, logData: {
          status: 'DEFERRED', deferReason: 'bill_with_delay_complaint',
          processingMs: Date.now() - startTime,
        }, db,
      })
      console.log(`[Full AI] ${whatsappNumber} — bill arrived amid a delay complaint, deferring to Ketu instead of auto-dispatch`)
      return
    }
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
    if (hasNonDispatchIntentText(mergedText) || await hasRecentDelayComplaint(db, conversation.id)) {
      scheduleDeferReply({
        whatsappNumber, deferMessage: settings.deferMessage, conversationId: conversation.id,
        mergedText, messageIds, logData: {
          status: 'DEFERRED', deferReason: 'bill_with_delay_complaint',
          processingMs: Date.now() - startTime,
        }, db,
      })
      console.log(`[Full AI] ${whatsappNumber} — invoice arrived amid a delay complaint, deferring to Ketu instead of auto-dispatch`)
      return
    }
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

  // --- 1-MIN FOLLOW-UP for new/7+day buyers (AI ON mode) ---
  // wwbun handles the welcome message (WA template send / IG Graph send — same
  // /welcome content since 2026-07-07). Digital-ketu2 only schedules the follow-up.
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
    console.log(`[Followup] ${whatsappNumber} — new/returning buyer, scheduling 1-min followup (wwbun sent welcome)`)

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
    }, WELCOME_FOLLOWUP_DELAY_MS)

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
// The 1-min welcome-followup is an in-memory setTimeout (pendingWelcomeFollowups).
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
    const fireBefore = new Date(now - WELCOME_FOLLOWUP_DELAY_MS)  // timer would already have fired
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

// Instagram persona addendum — appended as a SEPARATE (uncached) system block for 'ig:'
// conversations only, so the cached static WhatsApp prompt stays byte-identical (cache-safe)
// and the main persona is untouched.
const IG_SYSTEM_ADDENDUM = `

INSTAGRAM DM MODE — this buyer is messaging on INSTAGRAM, not WhatsApp:
- You are the business account's automated assistant (a business inbox, not Ketu's personal chat). Same products, prices, and knowledge rules as above.
- Keep replies to 2 short sentences MAX.
- For placing orders or detailed help, point the buyer to WhatsApp: wa.me/919336695049 (mention it at most once per conversation).
- Every other rule above still applies: language matching, authoritative prices only, never invent details, [DEFER]/[SKIP].`

async function runAiFlow({ whatsappNumber, mergedText, quotedText, conversationId, normalizedText, db, anthropic, settings, startTime, messageIds, imageUrl = null }) {
  const isInstagram = String(whatsappNumber || '').startsWith('ig:')
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

  // FORCE-REPLY PRE-GATE (audit 2026-07-16): the Haiku gate wrongly silenced real questions —
  // "Is there any option of return", "shop close kb rehti hai", "Ok..today dispatching?", even
  // "Ketu ji ko kaho baat karne ko" — and a silently-dropped message is INVISIBLE to the learning
  // loop (Ketu never sees it, so no correction can ever be born from it). High-signal intents
  // (returns/refunds, dispatch/pickup/tracking, delivery, shop hours, explicit ask-for-Ketu/call)
  // bypass the gate deterministically: the full flow may still [DEFER], but never pure silence.
  const FORCE_REPLY_RE = /\breturn\b|\brefund\b|\bexchange\b|wapas|वापस|\bdispatch|porter|pickup|\btrack|deliver|पहुंच|pahu?nch(a|e|eg)?|\b(shop|store|duk[a]?an|godam|warehouse|office)\b[^]{0,25}\b(clos|band|khul|open|tim|kab)|\b(kab|kitne)\b[^]{0,15}\b(khul|band|close|open)|\bketu\b|\bowner\b|\bmalik\b|baat\s*kar(a|wa)?\s*(o|do|ne|na)|\bcall\s*(kar|kr)/i
  const forcedReply = FORCE_REPLY_RE.test(mergedText || '')
  if (forcedReply) console.log(`[Restraint] ${whatsappNumber} — force-reply intent, gate bypassed`)

  // (B + C) "Would Om reply to this, or stay silent?" — a cheap Haiku gate BEFORE the expensive
  // RAG + reply. Skips acks/chatter/thinking-out-loud and avoids piling on right after a reply.
  // This is what makes the clone reply once and precisely, and it saves cost on no-reply messages.
  if (!forcedReply) try {
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

REPLY when the buyer asks a real question or needs a response: rates, products, sizes, colours, MOQ, availability, how to order, location, payment, an issue/complaint, or anything that clearly expects an answer. ALSO REPLY whenever the buyer asks for product PHOTOS / pictures / videos / HD photos / size chart / shipping cost / catalog — those always get a resource link, EVEN IF framed as a FUTURE or CONDITIONAL request ("naye designs aayein to photos aur videos bhej dena", "Instagram pe promote karunga", "future me chahiye honge") or the buyer is a reseller/dropshipper: that is a REPLY (send the link now), never silence. ALSO REPLY to visit/pickup asks — "main aa kar le sakta hu?", "pickup kar sakta hu?", "aa kar receive kar sakta hu?" — even mid-thread after an "ok": those get the visit answer (yes + address block), never silence (gate stayed silent on one and Ketu answered it manually, 2026-07-07).

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
    // CATALOG excluded 2026-07-09: every product's facts are now injected deterministically as the
    // AUTHORITATIVE CATALOG block, so pulling CATALOG chunks via fuzzy retrieval is redundant (and
    // used to MISS the right product — the whole reason for this change). RAG now supplies only
    // CORRECTION (Ketu's fixes) + SAVED_REPLY (his canned phrasing) — i.e. STYLE, not facts.
    excludeSources: ['STYLE_GUIDE', 'STYLE_PAIR', 'PREMIUM_PAIR', 'CATALOG'],
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

  // AUTHORITATIVE CATALOG — inject EVERY product's full facts (gsm, fabric, colours, sizes, price,
  // slug) on every request, so NO product fact ever depends on whether vector search happened to
  // retrieve that product's chunk. This is the "take facts off RAG" change (Ketu-approved
  // 2026-07-09): the vector DB matches by word-similarity, not situation, and kept missing or
  // surfacing the wrong/stale chunk — the root cause of the ₹160 price, the 88/12-vs-cotton fabric
  // slips, the size-chart error, etc. RAG now only supplies STYLE examples + corrections; the FACTS
  // come from here, deterministically. Grew out of the 2026-06-23 price-table fix.
  let priceTable = null
  try {
    const catalogChunks = await db.knowledgeChunk.findMany({
      where: { source: 'CATALOG' },
      select: { title: true, content: true, metadata: true },
    })
    const lines = []
    for (const c of catalogChunks) {
      const m = typeof c.metadata === 'string' ? JSON.parse(c.metadata) : (c.metadata || {})
      // Pull the fabric/composition from the chunk's "Description:" line (has 100% cotton / 88-12 /
      // terry / supercombed / biowash detail the metadata doesn't carry).
      const desc = ((c.content || '').match(/Description:\s*(.+)/i) || [])[1] || ''
      const fabric = desc.replace(/\s*\([^)]*\)/g, '').replace(/Premium Quality.*$/i, '').replace(/,\s*$/, '').trim().slice(0, 90)
      const parts = [`${c.title}`]
      if (m.gsm) parts.push(`${m.gsm}gsm`)
      if (fabric) parts.push(fabric)
      if (m.colors && m.colors.length) parts.push(`colours: ${m.colors.join('/')}`)
      if (m.sizes && m.sizes.length) parts.push(`sizes: ${m.sizes.join('/')}`)
      if (m.bulkPrice) parts.push(`bulk ₹${m.bulkPrice}`)
      if (m.samplePrice) parts.push(`sample ₹${m.samplePrice}`)
      if (m.slug) parts.push(`→ /catalog/p/${m.slug}`)
      lines.push(parts.join(' | '))
    }
    if (lines.length) priceTable = lines.sort().join('\n')
  } catch (err) {
    console.error(`[Catalog] ${whatsappNumber} — build failed, falling back to RAG-only facts:`, err.message)
  }

  const { staticPrompt, dynamicPrompt } = buildSystemPrompt({ settings, styleGuide, stylePairs: stylePairResults })
  const igAddendum = isInstagram ? IG_SYSTEM_ADDENDUM : ''
  // The AUTHORITATIVE CATALOG is IDENTICAL every request (changes only when the catalog syncs), so
  // it belongs in a CACHED block — NOT the uncached user message. Putting it in buildUserPrompt
  // (2026-07-09) cost ~₹2/reply extra (full-price ~1180 tokens each time) and blew the daily budget
  // → unreplied messages (2026-07-10). Now it's its own cached breakpoint after the static prompt:
  // cache-read (0.1×) on every reply, re-written only when the catalog changes.
  const catalogBlock = priceTable
    ? `AUTHORITATIVE CATALOG — the COMPLETE, current product list. This is the ONLY source of product FACTS: every price, GSM, fabric, colour, size and link the buyer could ask about is here. If you state ANY price/gsm/colour/size, it MUST be copied EXACTLY from this list (never round, never guess, never use a number from memory or the chat). "bulk" = 10+ pcs, "sample" = under 10 pcs — counted on the buyer's TOTAL order across ALL products combined, NOT per product (a 3-pc line inside an 18-pc total order is still BULK rate). A colour NOT listed for a product = we don't make it in that colour (send HD Photos). A product NOT in this list = we don't make it. If a listed detail isn't shown, don't invent it. (The KNOWLEDGE BASE in the user message is only for STYLE/how-Ketu-phrases-it — NOT for facts.)\n${priceTable}`
    : null
  const systemPrompt = staticPrompt + (catalogBlock ? '\n\n' + catalogBlock : '') + dynamicPrompt + igAddendum  // combined, for logging/grading
  // Prompt-cache the static prefix + catalog (both stable → 1h TTL); keep the per-query dynamic part
  // as a separate uncached block. buildSystemBlocks(ttl1h) lets us retry without it.
  const buildSystemBlocks = (use1h) => {
    const cc = use1h ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
    const blocks = [{ type: 'text', text: staticPrompt, cache_control: cc }]
    if (catalogBlock) blocks.push({ type: 'text', text: catalogBlock, cache_control: cc })  // cached breakpoint
    if (dynamicPrompt) blocks.push({ type: 'text', text: dynamicPrompt })
    if (igAddendum) blocks.push({ type: 'text', text: igAddendum })
    return blocks
  }
  let userPrompt = buildUserPrompt({
    mergedText,
    knowledgeResults,
    stylePairResults,
    conversationHistory,
    quotedText,
    priceTable,
  })

  // ORDER/TRACKING LOOKUP (2026-07-16, Ketu-approved): tracking/status asks were the #1 defer
  // bucket. On a tracking-ish intent, look up THIS buyer's own orders (read-only, own number ONLY)
  // and inject the result so the model can answer with the real tracking link instead of blank-
  // deferring. Any lookup failure → no block → the old defer behaviour is untouched.
  const TRACKING_INTENT_RE = /\btrack|awb|parcel|shipment|consignment|dispatch|pickup|courier|bhej(a|\s*diya)|\border\b[^]{0,40}(kaha|kahan|status|kab|mila|aaya|receive|pahu)|(kaha|kahan|status)[^]{0,25}\border/i
  // COMPLAINT/ANXIETY guard (audit 2026-07-20: Ketu corrected the auto-tracking-link to a DEFER on
  // "We haven't received anything yet, dispatched or NOT???" and a "send tracker id" — an anxious /
  // not-received / "problem" tracking message is a COMPLAINT he handles personally, not a case for a
  // canned link). On these, do NOT inject the lookup block → the normal defer rules apply.
  const TRACKING_COMPLAINT_RE = /haven.?t\s*(received|got)|not\s*(yet\s*)?(received|delivered|dispatched)|nahi\s*(aaya|aya|mila|mile|pahu|nikla)|abhi\s*tak|dispatched\s*or\s*not|\bproblem\b|kyu?n?\s*(nahi|nhi|late)|\blate\b|\d+\s*din\s*(ho|hue|se)|\?{3,}|still\s*(not|waiting|pending)/i
  if (!isInstagram && TRACKING_INTENT_RE.test(mergedText || '') && !TRACKING_COMPLAINT_RE.test(mergedText || '')) {
    try {
      const orders = await lookupOrdersByPhone(whatsappNumber)
      const block = formatOrderLookupBlock(orders)
      if (block) {
        userPrompt = block + '\n\n' + userPrompt
        console.log(`[OrderLookup] ${whatsappNumber} — injected ${orders ? orders.length : 0} order(s) for tracking intent`)
      }
    } catch (err) {
      console.error(`[OrderLookup] ${whatsappNumber} — lookup failed (falling back to defer):`, err.message)
    }
  }

  // LIVE STOCK FEED (2026-07-21, Ketu-approved): "is X in stock?" was the #1 defer bucket. On a
  // stock-ish intent, inject the live snapshot (website pc.js = in/out of stock + supplier-app
  // coming-soon ETAs) so the model answers from real data instead of blank-deferring. Generous
  // regex is fine — over-firing only adds ~850 trusted tokens; under-firing keeps the old defer.
  // Any fetch failure → no block → the old always-defer behaviour is untouched (fail-closed).
  const STOCK_INTENT_RE = /stock|avail|milega|milegi|mil\s*(jayega|sakta|sakti)|restock|aa\s*(gaya|gay[ei]|jayega|raha)|aayega|ayega|kab\s*(aa|tak|milega|mileg)|hai\s*(kya|k[eya])|h[ae]i?\s*\?|\bhoga\b|\bhai\b.{0,12}\?|out\s*of\s*stock|in\s*stock|khat?am|finish/i
  if (STOCK_INTENT_RE.test(mergedText || '')) {
    try {
      const stockBlock = formatStockBlock(await getStockSnapshot())
      if (stockBlock) {
        userPrompt = stockBlock + '\n\n' + userPrompt
        console.log(`[StockLookup] ${whatsappNumber} — injected live stock block for stock intent`)
      }
    } catch (err) {
      console.error(`[StockLookup] ${whatsappNumber} — fetch failed (falling back to defer):`, err.message)
    }
  }

  // BUYER PROFILE (2026-07-21, Ketu-approved roadmap step 2): compact ~60-token background line on
  // EVERY WhatsApp turn — order count, last order (products + ₹), booking state — so the clone
  // treats a 20-order regular like a known buyer, not a stranger, and "kahan tak aaya" has an
  // anchor. Read-only, buyer's own number only, 10-min cache; any failure → no block (fail-open).
  if (!isInstagram) {
    try {
      const profileBlock = formatBuyerProfileBlock(await getBuyerProfile(whatsappNumber))
      if (profileBlock) userPrompt = profileBlock + '\n\n' + userPrompt
    } catch (err) {
      console.error(`[BuyerProfile] ${whatsappNumber} — profile fetch failed (skipping):`, err.message)
    }
  }

  // "AAJ KA NOTE" daily-pulse (2026-07-21): one line from Ketu shapes ALL of today's replies.
  // Valid only for the IST day it was set — stale notes are ignored automatically (no cron).
  if (settings.dailyNote && settings.dailyNoteSetAt) {
    const istDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    if (istDay(settings.dailyNoteSetAt) === istDay(Date.now())) {
      userPrompt = `📌 AAJ KA NOTE (from Ketu HIMSELF, applies to ALL replies TODAY — factor it in where relevant, don't recite it verbatim unless it answers the question): ${settings.dailyNote}\n\n${userPrompt}`
    }
  }

  // BUYER MEMORY (2026-07-21): durable per-buyer facts — language preference + admin notes.
  // ~20 tokens, only when a memory row exists. Failure → skip (fail-open).
  try {
    const mem = await db.buyerMemory.findUnique({ where: { whatsappNumber } })
    if (mem && (mem.language || mem.notes)) {
      const bits = []
      if (mem.language) bits.push(`this buyer EXPLICITLY asked for ${mem.language.toUpperCase()} in an earlier chat — ALWAYS reply in ${mem.language} (overrides language-matching)`)
      if (mem.notes) bits.push(`notes from Ketu: ${mem.notes}`)
      userPrompt = `🧠 BUYER MEMORY (durable facts about THIS buyer): ${bits.join('; ')}.\n\n${userPrompt}`
    }
  } catch { /* table may not exist yet on first boot — skip */ }

  // Auto-learn an EXPLICIT language request so it survives across threads (the rulebook already
  // honors it within-thread; this makes "English please" permanent). Fire-and-forget.
  const langAsk = /\b(in english|english please|english me(?:in)?\s*(bolo|batao|reply|likho)?|please english|reply in english|only english)\b/i.test(mergedText || '') ? 'english'
    : /\b(hindi me(?:in)?\s*(bolo|batao|baat|reply|likho)|in hindi|hindi please|reply in hindi)\b/i.test(mergedText || '') ? 'hindi' : null
  if (langAsk && !isInstagram) {
    db.buyerMemory.upsert({
      where: { whatsappNumber },
      update: { language: langAsk },
      create: { whatsappNumber, language: langAsk },
    }).then(() => console.log(`[BuyerMemory] ${whatsappNumber} — language preference saved: ${langAsk}`))
      .catch(() => {})
  }

  // Vision: tell the model a real photo is attached and how to use it (no hallucinated prices/details).
  if (imageBlock) {
    userPrompt = `📷 The buyer attached a PHOTO (sent with this message). Look at the image carefully. OUTPUT ONLY the final WhatsApp message to send the buyer (first-person, as Om, casual Hinglish) — NEVER narrate or describe the image or your analysis: do NOT write "This is a screenshot of...", "The buyer has built their cart", "they have NOT paid yet", or ANY third-person description / reasoning (that is internal-only); send JUST the message text the buyer should receive.\nFIRST: if the photo is a SCREENSHOT of OUR WEBSITE — an Order Summary / cart / checkout page, or one showing a "Pay Now" / "Order Now" / "Place order" / "Add to cart" button (the buyer has built their order and is showing it / asking how to finish) — they have NOT paid yet, so do NOT say "dispatching" and do NOT defer. Guide them to complete it: "Pay Now button click karke order complete kar lijiye sir, payment ke baad dispatch ho jayega 👉 https://sale91.com". EXCEPTION — if the website screenshot shows the item OUT OF STOCK / "No stock" (or the buyer's text says so), do NOT bounce them back with "website pe hai, order kar lijiye" (it contradicts what they just showed): reply EXACTLY [DEFER] — only Ketu knows real-time stock (POLICY Ketu 2026-07-16: NEVER assert in/out of stock, do NOT say "out lag raha hai"); he handles the stock status + any alternative.\nBUT if the photo is a BILL / TAX INVOICE / order receipt (a FINALISED order — has an Invoice No., Total, "Pay To" bank details — NOT a cart) AND the buyer wants to ADD or CHANGE something ("add this as well", "ye bhi add kar do", "isme ye bhi daal do"), that is an order MODIFICATION → reply EXACTLY [DEFER] (only Ketu can add the item / confirm which product) — do NOT say "dispatching", do NOT acknowledge a dispatch, and do NOT interrogate for product/colour/size when the IMAGE itself shows the item to add ("ye bhi add karva do" + a product photo = the photo IS the answer — read it and defer with it; clone asked "kya add karna hai? product, colour, size bata dijiye" to a photo that showed exactly that, 2026-07-03).\nALSO — if the buyer's TEXT asks for TRACKING ("I want tracking details", "tracking chahiye", "track my order", "order kahan hai", order STATUS) — EVEN when the image is an Order-Confirmed / order page that itself says "dispatching in a few minutes" — reply EXACTLY [DEFER] — UNLESS a "📦 ORDER LOOKUP RESULT" block is present in this request: then answer the plain status/tracking ask FROM that block (short + the tracking link), complaints/no-AWB still [DEFER]. Never answer "dispatching ASAP" to a tracking request.\nORDER-DETAILS SCREENSHOT — if the photo is a LIST / SUMMARY of products + sizes + quantities the buyer is SHARING or confirming (an order breakdown, e.g. "240gsm Black M:5 L:5, White XL:3..."), with NO clear complaint, NO bill/payment markers (no Invoice No / Pay-To), NO cart "Pay Now" button, and NO explicit add/change request, the safest reply is simply "Noted sir 🙏" — nothing else (Ketu 2026-06-16, buyer 8437375306: such a screenshot can mean many things, so a clean "Noted" is the best answer; do NOT route it to the stock sheet / catalog / product page and do NOT say "dispatching" or ask which item).\nSECOND: if the photo shows a POSSIBLE PROBLEM on a garment — stains, marks, chalk lines, holes, loose threads, damage, wrong/odd print, a measuring tape on the garment, or the buyer's text sounds like a complaint/showing an issue ("this is hilarious", "ye kya hai", "dekho isko", "issue", "quality kharab/karap kyu hai", "fade ho gaya", emoji-only disappointment) — they are REPORTING a received-product problem, NOT shopping: reply EXACTLY [DEFER] — even if you can identify the product, a quality-negative caption makes it a complaint, NEVER a product-ID + catalog link (clone answered "Acid wash oversize hai sir 👉 link" to "quality thora karap kyu hai", 2026-07-03) (Ketu inspects defect photos personally — e.g. he identified chalk marks a buyer sent 2026-06-11 while the clone wrongly answered "cream round neck, catalog dekh lijiye"). NON-GARMENT PRODUCT they want us to supply — if the image is a HOME TEXTILE or other non-garment PRODUCT (a bedsheet / chadar, towel, curtain, blanket, or raw fabric / cloth) and the text is asking for it ("aisa bedsheet milega", "ye banaoge", "isa chahiye"), do NOT defer — tell them directly we only make t-shirts: "Hum sirf t-shirts/garments banate hain sir, ye nahi 👉 https://sale91.com/catalog" (Ketu 2026-06-27, buyer 6232320603). ALSO: if the photo is clearly NOT apparel / a garment / a product we could sell (a selfie, a meme, a screenshot of text or chat, a document, a random object), OR if the image is blank / unclear / blurry / you cannot actually make out a garment, reply with EXACTLY [DEFER] and nothing else — do NOT guess.\nPRINTED/BRANDED TEE + COLOUR ASK — a buyer showing a PRINTED or branded tee and asking about its COLOUR ("ei colour ta ki hobe", "ye colour milega?") wants OUR BLANK in that colour, NOT a print service: identify the colour and answer for the blank ("Army green hai sir 👉 [deep-link/HD Photos]") — do NOT reply "print wala nahi banate" to a colour question (clone did; Ketu answered "Yes army green tshirt available" + the product photo, 2026-07-06). Mention printing only if they ask for printing. PHOTO AFTER A BILL — if the recent thread shows a BILL was just sent (with or without a dispatch-ack), a product photo now is NOT a dispatch confirmation: it is usually EVIDENCE (missing/wrong/damaged piece) or an add-item → reply EXACTLY [DEFER]; never "dispatching ASAP" (2026-07-05, buyer 6353441274). OTHERWISE, identify which of our products it is (tshirt / oversized / polo / hoodie / sweatshirt / acid wash / drop shoulder / etc.) ONLY if you are genuinely confident from what you SEE. Reply about THAT product the way Om would: if it clearly matches something we make, say so briefly and send the catalog link https://sale91.com/catalog (use a specific product link only if one is given in the knowledge base above). If you are NOT sure which product it is, do NOT name one — ask "Kaunsa product chahiye sir?" instead of guessing a type (e.g. never say "polo" unless you can clearly see a collar). NEVER assert a FABRIC/KNIT TYPE from a photo ("single jersey", "matty", "pique", "terry") — knit identification from an image is unreliable (clone called a competitor sample "single jersey"; Ketu's answer was "Matty hai", 2026-07-03): for fabric-ID asks on buyer photos (especially competitor samples they want matched), [DEFER] — Ketu identifies fabrics personally. SIZE-LABEL STICKER COLOUR → GSM (OUR oversize samples ONLY; Ketu's own fact 2026-07-22): when a buyer shows OUR sample tees and asks which GSM is which, the round size-label sticker's COLOUR tells: BEIGE/cream label = 180gsm, RED label = 210gsm — answer per Ketu: "Beige label wala 180gsm hai sir, red label wala 210gsm". Do NOT extend this mapping to any other product/label colour (a colour not in this map, or a non-oversize product → don't guess, [DEFER]); never call the beige label "white". CRITICAL — NOT-MADE GARMENT TYPES: if the pictured garment is a type we do NOT make — a FULL-SLEEVE / long-sleeve T-SHIRT (our only long-sleeve items are sweatshirt / hoodie / drop-shoulder hoodie — there is NO long-sleeve tee), a collared woven "normal shirt", jeans/joggers etc. — say we don't make it: "Is tarah ka nahi banate sir — full-sleeve mein sweatshirt/hoodie hai 👉 https://sale91.com/catalog". NEVER say "ye website pe hai" for a type that isn't in the catalog (clone told a full-sleeve-tee buyer it was on the website; Ketu corrected "Nahi hai is tarah ka", 2026-07-01). If the buyer then NEGATES your identification ("sweatshirt nahi hai vo", "vo X nahi hai") they are CORRECTING you — do not re-push X's link; if what they describe isn't a catalog type, deny it plainly. And if a buyer asks whether we can SUPPLY/match a pictured fabric/garment and you are not CERTAIN it's a catalog product, [DEFER] — do not assert we have it (clone said a fabric photo "sublimation jaisa lag raha hai" and implied we stock it; Ketu said "Nahi", 2026-06-30). NEVER invent a price, GSM, or detail not in the knowledge base, and never claim it is in/out of stock (EXCEPTION: if a "📦 LIVE STOCK DATA" block is present in this request, answer stock questions FROM that block per its rules).\n\n${userPrompt}`
  }

  // --- Call Claude API ---
  let aiReply
  let promptTokens, completionTokens, totalTokens, costUsd
  let usedFallbackBrain = null  // set to the OpenAI model name when the fallback answered

  try {
    const userMessages = [{ role: 'user', content: imageBlock ? [imageBlock, { type: 'text', text: userPrompt }] : userPrompt }]
    // Buyer-reply brain — switchable from wwbun (Settings.replyModel), allow-listed to Opus-tier.
    // thinking:disabled keeps EVERY model terse (mandatory on Opus 5, which thinks-on by default).
    const replyModel = resolveReplyModel(settings)
    let response
    let used1hCache = false
    // Try the 1-hour cache TTL first (bigger savings with spaced traffic); on error fall back to
    // the standard 5-min ephemeral cache for THIS reply and retry the 1h path after 15 minutes.
    if (Date.now() >= extendedCacheTtlRetryAt) {
      try {
        response = await anthropic.messages.create(
          { model: replyModel, max_tokens: 500, thinking: { type: 'disabled' }, system: buildSystemBlocks(true), messages: userMessages },
          { headers: { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } }
        )
        used1hCache = true
      } catch (e) {
        console.error(`[Cache] 1h TTL attempt failed (status=${e.status || '?'}; retrying 1h path in 15 min):`, e.message)
        extendedCacheTtlRetryAt = Date.now() + 15 * 60 * 1000
      }
    }
    if (!response) {
      response = await anthropic.messages.create({
        model: replyModel, max_tokens: 500, thinking: { type: 'disabled' }, system: buildSystemBlocks(false), messages: userMessages,
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
    const writeMultiplier = used1hCache ? 2.0 : 1.25
    costUsd = (freshInput * REPLY_PRICE_PER_INPUT_TOKEN)
      + (cacheWrite * REPLY_PRICE_PER_INPUT_TOKEN * writeMultiplier)
      + (cacheRead * REPLY_PRICE_PER_INPUT_TOKEN * 0.10)
      + (completionTokens * REPLY_PRICE_PER_OUTPUT_TOKEN)
    if (used1hCache) cacheTouch.at = Date.now()  // 1h static-prompt cache is warm as of now
  } catch (err) {
    console.error(`[Claude Error] ${whatsappNumber}:`, err.message)
    const em = String(err?.message || '')
    // AI-BRAIN-DOWN (Anthropic credits/billing/auth suspended). Claude Opus 4.8 is PRIMARY (the more
    // faithful clone); when it's down, fail over to the OPENAI FALLBACK BRAIN (gpt-4o-mini, reusing
    // the transcription OPENAI_API_KEY) so the shop keeps replying instead of going dark. Auto-reverts
    // to Claude the moment credits return. Ketu-approved 2026-07-20 during the Anthropic-credits outage.
    const isBrainDown = /credit balance is too low|usage limit|billing|payment required|insufficient|authentication_error|invalid.{0,4}api.?key|\b401\b|\b402\b|\b429\b|overloaded/i.test(em)
    if (isBrainDown) {
      if (Date.now() - lastBrainDownAlertAt > 3 * 3600 * 1000) {
        lastBrainDownAlertAt = Date.now()
        notifyOwner(`⚠️ dk2 Claude down ("${em.slice(0, 60)}") — OpenAI fallback (gpt-4o-mini) chalu hai, buyers ko reply ja raha hai. Anthropic credits fix karte hi Claude wapas.`).catch(() => {})
        console.log(`[BrainDown] ${whatsappNumber} — Claude down (${em.slice(0, 50)}); trying OpenAI fallback`)
      }
      if (isOpenAiFallbackConfigured()) {
        const fb = await openaiReply({ systemText: systemPrompt, userText: userPrompt, imageBlock })
        if (fb && fb.reply) {
          aiReply = fb.reply
          usedFallbackBrain = fb.model
          fallbackState.at = Date.now(); fallbackState.model = fb.model
          promptTokens = 0; completionTokens = 0; totalTokens = 0
          costUsd = fb.costUsd
          console.log(`[Fallback] ${whatsappNumber} — replied via ${fb.model} ($${fb.costUsd.toFixed(4)})`)
        }
      }
    }
    if (!aiReply) {
      await createLog(db, conversationId, mergedText, messageIds, {
        status: 'FAILED',
        deferReason: err.message,
        knowledgeChunks: allVectorResults.map(c => ({ title: c.title, source: c.source, similarity: Number(c.similarity).toFixed(3) })),
        processingMs: Date.now() - startTime,
      })
      return
    }
  }

  // --- REASONING-LEAK GUARD ---
  // The reply brain occasionally dumps its internal chain-of-thought into the buyer message
  // ("Wait - ... Let me reconsider ... This is a RAW WHATSAPP ORDER ... the buyer shared a photo").
  // Never let that reach a buyer. If the reply looks like leaked reasoning, defer to Ketu instead.
  // XML think/reasoning tags first (Opus 5 with thinking disabled can occasionally emit these) — must
  // never reach a buyer, and this makes them defer + count toward the reasoning-leak signal.
  const _leakMarkers = /<\/?think(ing)?>|<\/?reasoning>|\bWait\s*[-—,:]|Let me (reconsider|think|re-?check)|RAW WHATSAPP ORDER|the buyer (shared|is asking|wants|gave)|the previous context|which means (Regular Fit|the buyer)|\bRoute to website\b|this is a size breakdown|\bI should (reply|defer|reconsider|send)/i
  const _wc = (aiReply || '').trim().split(/\s+/).filter(Boolean).length
  const _paras = ((aiReply || '').match(/\n\s*\n/g) || []).length
  // Block ONLY on an explicit chain-of-thought marker, or an EXTREME length dump (>120 words —
  // well above any legitimate reply). Do NOT block on length/paragraphs alone: legitimate replies
  // are often multi-line and >60 words (the full Delhi visit-address block, store-hours, an
  // enumerated product family, the train-flow explanation). Blocking those was deferring real
  // answers (Ketu 2026-06-08: "share your delhi shop address" got deferred instead of the address).
  if (_leakMarkers.test(aiReply || '') || _wc > 120) {
    console.warn(`[LeakGuard] ${whatsappNumber} — reply looked like a reasoning leak (${_wc} words, ${_paras} para-breaks); deferring. First 120: ${(aiReply || '').slice(0, 120)}`)
    scheduleDeferReply({
      whatsappNumber, deferMessage: settings.deferMessage, conversationId,
      mergedText, messageIds, logData: {
        status: 'DEFERRED', deferReason: 'reasoning_leak_blocked',
        aiReply, promptTokens, completionTokens, totalTokens, costUsd,
        processingMs: Date.now() - startTime,
      }, db,
    })
    await db.settings.update({ where: { id: 'default' }, data: { dailySpentUsd: { increment: costUsd } } })
    return
  }

  // --- MEDIA RE-ASK GUARD ---
  // (Ketu 2026-07-21, buyer 919910024230 / Rajat: sent a screenshot 3× and got "Screenshot bhej
  // dijiye" 3× — you can NEVER ask a buyer to send media they just sent.) If this message carried an
  // image/screenshot and the reply asks the buyer to SEND a screenshot/photo, that's a contradiction
  // and a loop → defer to Ketu (he can see the media in wwbun) instead. Matches "bhej dijiye/do/dena/
  // karo", "dobara", "send/share the photo" — but NOT "photos bhej deta hun" (clone offering to send).
  const MEDIA_REASK_RE = /(screenshot|photo|image|pic(ture)?)\s*(ko\s*)?(dobara|dubara|firse|phir\s*se)|(screenshot|photo|image|pic(ture)?)\s*(bhej|send|share)\s*(dijiye|dijiyega|do\b|dena|de\s*d|karo|kar\s*d)|(send|share)\s*(me\s*)?(the\s*)?(screenshot|photo|image|pic(ture)?)|photo\s*(aayi\s*nahi|nahi\s*aayi)/i
  // The buyer "sent a photo" if a real image downloaded OR their message is just a photo PLACEHOLDER
  // (the image failed to download — the media-race). BOTH mean a re-ask ("bhej dijiye") loops them
  // (Ketu 2026-07-22, buyer 919910024230/Rajat: a "[product photo]" whose image never downloaded got
  // "Screenshot bhej dijiye" 3× in a row — the guard missed it because imageBlock was null). Ketu can
  // see the photo in wwbun, so defer instead of asking again.
  const buyerSentPhoto = imageBlock || imageUrl || /\[(product\s*photo|image|photo|pic(ture)?|screenshot)\]/i.test(mergedText || '')
  if (buyerSentPhoto && MEDIA_REASK_RE.test(aiReply || '')) {
    console.warn(`[MediaReask] ${whatsappNumber} — reply asked for a screenshot the buyer already sent; deferring instead of looping. Reply: ${(aiReply || '').slice(0, 80)}`)
    scheduleDeferReply({
      whatsappNumber, deferMessage: settings.deferMessage, conversationId,
      mergedText, messageIds, logData: {
        status: 'DEFERRED', deferReason: 'media_reask_blocked',
        aiReply, promptTokens, completionTokens, totalTokens, costUsd,
        processingMs: Date.now() - startTime,
      }, db,
    })
    await db.settings.update({ where: { id: 'default' }, data: { dailySpentUsd: { increment: costUsd } } }).catch(() => {})
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

  // --- ENGLISH LANGUAGE GATE (2026-07-21, Ketu-approved roadmap step: "fix with a CODE gate, not
  // more rules") --- The #1 remaining VOICE slip: the model reverts to Hinglish for a clearly
  // ENGLISH buyer (14+ repeats in the 2026-07-20 audit despite TWO CRITICAL-tagged prompt rules —
  // prompt pressure has provably plateaued). Deterministic check: buyer wrote real English (no
  // Devanagari, zero Hinglish tokens, ≥2 English markers, ≥3 words) but the reply contains Hinglish
  // → ONE cheap rewrite call (Haiku; OpenAI fallback when Anthropic is down). If the rewrite fails
  // or still trips, send the ORIGINAL — an imperfect reply beats silence. Never blocks, only fixes.
  const DEVANAGARI_RE = /[ऀ-ॿ]/
  const HINGLISH_TOKEN_RE = /\b(hai|hain|nahi|nhi|karo|kariye|karke|lijiye|dijiye|bhejo|bhejiye|bataiye|batao|batana|aap|aapka|aapke|apka|kya|kyu|kyon|mein|milega|milegi|chahiye|wala|wale|wali|bhaiya|abhi|sirf|hoga|hogi|karna|karni|krna|dedo|lelo|dekhiye|kitna|kitne|kitni|kaise|kaha|kahan|jaldi|maal|jayega|jayegi|karwa|karva|bhej|laga|lag|raha|rahi|gaya|gayi)\b/i
  const ENGLISH_MARKER_RE = /\b(the|is|are|do|does|can|could|will|would|please|want|need|have|has|you|your|what|when|where|how|much|many|price|order|delivery|available|stock|send|share|tell|about|this|that|with|and|for|from|there|any)\b/gi
  const buyerWords = (mergedText || '').trim().split(/\s+/).filter(Boolean)
  const buyerIsEnglish = buyerWords.length >= 3
    && !DEVANAGARI_RE.test(mergedText || '')
    && !HINGLISH_TOKEN_RE.test(mergedText || '')
    && ((mergedText || '').match(ENGLISH_MARKER_RE) || []).length >= 2
  if (buyerIsEnglish && (HINGLISH_TOKEN_RE.test(aiReply || '') || DEVANAGARI_RE.test(aiReply || ''))) {
    console.warn(`[EnglishGate] ${whatsappNumber} — English buyer got Hinglish reply; rewriting. Original: ${(aiReply || '').slice(0, 90)}`)
    const rewritePrompt = `Rewrite this WhatsApp reply in natural ENGLISH ONLY — no Hindi/Hinglish words (hai, nahi, kar lijiye, milega, etc.). Same meaning, same terse length. Keep "sir", links, emojis and ₹ prices unchanged. Output ONLY the rewritten message.\n\n${aiReply}`
    let rewritten = null
    try {
      const rw = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        messages: [{ role: 'user', content: rewritePrompt }],
      })
      rewritten = (rw.content?.[0]?.text || '').trim()
      costUsd += ((rw.usage?.input_tokens || 0) * 1 + (rw.usage?.output_tokens || 0) * 5) / 1_000_000
    } catch (err) {
      try {
        const rw = await openaiReply({ systemText: 'You rewrite WhatsApp replies. Output only the rewritten message.', userText: rewritePrompt })
        if (rw?.reply) { rewritten = rw.reply.trim(); costUsd += rw.costUsd || 0 }
      } catch { /* both brains failed → keep original */ }
    }
    if (rewritten && !HINGLISH_TOKEN_RE.test(rewritten) && !DEVANAGARI_RE.test(rewritten) && rewritten.length <= (aiReply.length * 2 + 80)) {
      aiReply = rewritten
      console.log(`[EnglishGate] ${whatsappNumber} — rewrite OK: ${aiReply.slice(0, 90)}`)
    } else {
      console.warn(`[EnglishGate] ${whatsappNumber} — rewrite failed/still Hinglish; sending original`)
    }
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

  // --- IG-only pre-send guards: 24h messaging window + first-reply automation disclosure ---
  if (isInstagram) {
    try {
      // Meta rejects sends >24h after the buyer's last inbound (error 10). lastMessageAt is
      // refreshed on every inbound, so this only trips on stale buffered/recovered work.
      const igConv = await db.buyerConversation.findUnique({
        where: { whatsappNumber },
        select: { lastMessageAt: true },
      })
      const lastInboundMs = igConv?.lastMessageAt ? new Date(igConv.lastMessageAt).getTime() : 0
      if (!lastInboundMs || Date.now() - lastInboundMs > 24 * 60 * 60 * 1000) {
        await createLog(db, conversationId, mergedText, messageIds, {
          status: 'SKIPPED',
          deferReason: 'ig_window_expired',
          aiReply,
          promptTokens, completionTokens, totalTokens, costUsd,
          processingMs: Date.now() - startTime,
        })
        await db.settings.update({ where: { id: 'default' }, data: { dailySpentUsd: { increment: costUsd } } })
        console.log(`[IG] ${whatsappNumber} — 24h messaging window expired, suppressing send`)
        return
      }
      // First reply of an IG conversation carries the automation disclosure.
      const priorReplied = await db.messageLog.findFirst({
        where: { conversationId, status: 'REPLIED' },
        select: { id: true },
      })
      if (!priorReplied) aiReply = `${aiReply} — (auto-reply)`
    } catch (err) {
      console.error(`[IG] ${whatsappNumber} — pre-send guard error (sending anyway):`, err.message)
    }
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
    deferReason: usedFallbackBrain ? `openai_fallback:${usedFallbackBrain}` : undefined,
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

function buildUserPrompt({ mergedText, knowledgeResults, stylePairResults, conversationHistory, quotedText, priceTable }) {
  let prompt = ''

  // Current IST date/day (computed per-request) so date-relative questions — store hours on
  // "aaj/kal/today/tomorrow open?" — are answered with the CORRECT day, not a guess.
  const _IST_MS = 5.5 * 60 * 60 * 1000
  const _DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const _nowIST = new Date(Date.now() + _IST_MS)
  const _tomIST = new Date(Date.now() + _IST_MS + 86400000)
  prompt += `TODAY (IST): ${_DAYS[_nowIST.getUTCDay()]}, ${_nowIST.toISOString().slice(0, 10)}. TOMORROW (IST): ${_DAYS[_tomIST.getUTCDay()]}. (Use this ONLY for date-relative questions like store hours on "aaj/kal/today/tomorrow" — never volunteer the date unprompted.)\n\n`

  // AUTHORITATIVE CATALOG (every product's full facts, every request) — the model must take ALL
  // product FACTS (price, gsm, fabric, colours, sizes, link) from here, never from a retrieval gap
  // or memory. This is the deterministic fact source that replaces trusting the vector DB for facts.
  if (false && priceTable) {  // catalog moved to a CACHED system block (2026-07-11 cost fix); kept guard for clarity
    prompt += ``
  }

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
// Send reply via Instagram Graph API ('ig:' conversations)
// ===========================================
// Mirrors sendReplyViaWwbun's native-fetch + 2-retry backoff. Returns { messageId } so
// sendResult?.messageId works unchanged at every call site. IG DM text caps at 1000 chars.
async function sendReplyViaInstagram(igsid, message) {
  if (!IG_MSG_TOKEN || !IG_BUSINESS_ID) {
    console.error('[IGSend] IG_MSG_TOKEN or IG_BUSINESS_ID not configured — message NOT sent to', igsid)
    return null
  }

  let text = String(message || '')
  if (text.length > 990) text = text.slice(0, 987) + '…'

  // /me/messages resolves to the Page the token belongs to — the canonical
  // Instagram-Messaging form for Facebook-Login page tokens
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(IG_MSG_TOKEN)}`
  const MAX_RETRIES = 2
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const errInfo = JSON.stringify(data.error || data).slice(0, 300)
        // Error code 10 = outside Meta's 24h messaging window — final, never retry
        if (data.error?.code === 10) {
          console.error(`[IGSend] ${igsid} — outside 24h messaging window (code 10), NOT retrying: ${errInfo}`)
          return null
        }
        console.error(`[IGSend] Graph API error (attempt ${attempt}/${MAX_RETRIES}): ${response.status} — ${igsid} — ${errInfo}`)
        if (attempt < MAX_RETRIES && response.status >= 500) {
          await new Promise(r => setTimeout(r, 1000 * attempt))
          continue
        }
        return null
      }
      if (attempt > 1) console.log(`[IGSend] ${igsid} — succeeded on retry attempt ${attempt}`)
      return { messageId: data.message_id || null }
    } catch (err) {
      console.error(`[IGSend] Failed (attempt ${attempt}/${MAX_RETRIES}): ${igsid} — ${err.message}`)
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
// Send reply via wwbun API
// ===========================================

export async function sendReplyViaWwbun(whatsappNumber, message) {
  // 'ig:' keys flow through wwbun like any number since 2026-07-07 — wwbun's
  // send-ai-reply branches on the prefix and does the Graph send + store + emit,
  // so IG replies appear in the operator's threads. (sendReplyViaInstagram below
  // is retained as dormant fallback for the dk2-direct webhook path.)

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
      lastReplySentAt.set(whatsappNumber, Date.now()) // a reply went out — the caller must NOT then clear the badge
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

// Digital Ketu concluded WITHOUT sending a reply (cooldown, off-hours, filtered, error, …).
// Tell wwbun so it can clear the "Digital Ketu is preparing a reply" badge it showed when the
// message was handed off — otherwise the badge lingers until wwbun's 2-min client self-heal and
// re-shows on every message during cooldown, so it looks permanently stuck. Fire-and-forget: a
// failure here only delays the badge to that self-heal; it never blocks or affects the reply path.
export async function notifySkippedViaWwbun(whatsappNumber) {
  if (!WWBUN_API_URL || !DIGITAL_KETU_SECRET) return
  try {
    await fetch(`${WWBUN_API_URL}/api/messages/ai-reply-skipped`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Digital-Ketu-Secret': DIGITAL_KETU_SECRET },
      body: JSON.stringify({ whatsappNumber }),
    })
  } catch (err) {
    console.error('[Skip-notify] failed for', whatsappNumber, '—', err.message)
  }
}

// Owner alert channel — a WhatsApp to Ketu himself (his own number), reusing the wwbun send path.
// Used by the cost-ceiling alarm so a runaway per-reply cost surfaces to him automatically instead
// of him having to watch the chart. OWNER_WHATSAPP overridable via env; falls back to his number.
const OWNER_WHATSAPP = process.env.OWNER_WHATSAPP || '918527150400'
export async function notifyOwner(message) {
  if (!OWNER_WHATSAPP) return null
  return sendReplyViaWwbun(OWNER_WHATSAPP, message)
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
