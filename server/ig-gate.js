// Instagram DM cost gate — decides what an 'ig:' conversation's message deserves BEFORE any
// paid AI/embedding call is made. Pure JS string checks + cheap DB counts only (ZERO Anthropic
// or Voyage calls in here — that is the whole point). Applied ONLY to conversation keys that
// start with 'ig:'; the WhatsApp pipeline never touches this module.
//
// Tiers (checked in order):
//   ZERO  → no reply, no AI (emoji-only, '[media]' markers, story replies, bare greetings)
//   AI    → EVERYTHING ELSE. Same treatment a WhatsApp message gets (Ketu 2026-07-28).
//   CAPS  → the AI tier is still capped: per-user 25 AI replies/day + global IG 100/day (IST)
//
// This module only DECIDES — the caller (process.js) performs the send + MessageLog write.

const IG_CAP_TEXT = 'Ji sir 🙏 aapka message mil gaya — thodi der mein yahin reply karte hain.'

// Per-user cap raised 10 → 25 to match REPLY_DAILY_CAP in process.js, which is NOT Instagram-
// gated and therefore already applies here. A genuine buyer working through sizes, colours and
// rates burns 10 turns easily, and hitting a cap mid-conversation reads as us going silent.
// The global 100/day ceiling is unchanged and is what actually bounds the spend.
const IG_PER_USER_DAILY_AI_CAP = 25
const IG_GLOBAL_DAILY_AI_CAP = 100
const IG_24H_MS = 24 * 60 * 60 * 1000

// Buyer-intent keywords (case-insensitive partial match) — any hit = full AI pipeline
const BUYER_INTENT_KEYWORDS = [
  'price', 'rate', 'order', 'moq', 'bulk', 'gsm', 'wholesale', 'sample', 'cod',
  'delivery', 'shipping', 'stock', 'size', 'colour', 'color', 'tshirt', 't-shirt',
  'hoodie', 'kitna', 'kitne', 'kimat', 'keemat', 'daam', 'chahiye',
  // An MOQ question phrased in plain English matched NOTHING above, so a real buyer got the
  // canned nudge instead of an answer (Ketu 2026-07-28, Aakash: "What would the minimum
  // quantity be?"). These are unambiguous buying signals — casual chatters do not use them.
  'minimum', 'quantity', 'qty', 'pcs', 'piece', 'kitni',
  'कीमत', 'कितना', 'कितने', 'ऑर्डर', 'थोक',
]

// One-word greetings / acks that deserve no reply at all (ZERO tier)
const ZERO_GREETINGS = new Set([
  'hi', 'hello', 'hey', 'helo', 'hlo', 'hllo', 'namaste', 'namaskar',
  'ok', 'okay', 'thanks', 'thank you', 'thanku', 'thankyou', 'thx', 'ty',
  'gm', 'good morning', 'good afternoon', 'good evening',
])

// Midnight IST (used for the daily AI-reply cap counts)
function istDayStart() {
  const IST_MS = 5.5 * 60 * 60 * 1000
  const nowIst = new Date(Date.now() + IST_MS)
  return new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST_MS)
}

function isEmojiOnly(text) {
  const t = String(text || '')
  // Require at least one real pictograph, then nothing left once emoji parts are stripped.
  // (Deliberately NOT \p{Emoji_Component} in a bare character class — it matches digits 0-9,
  // which would silently swallow a buyer sending a phone/order number.)
  if (!/\p{Extended_Pictographic}/u.test(t)) return false
  return t.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣\s]/gu, '') === ''
}

function isZeroTier(mergedText, messages) {
  const t = (mergedText || '').trim()
  // A real photo or voice note the clone can actually PROCESS is not "nothing" — WhatsApp runs
  // vision on a buyer's product photo and transcribes his voice note, so Instagram must too
  // (Ketu 2026-07-28). A captionless photo arrives with empty text, which the `!t` check below
  // would otherwise swallow silently. wwbun only ever labels a genuine image/audio attachment
  // this way — reels, shares, stickers and story mentions still arrive as '[media]' text and
  // stay free on the ZERO tier.
  if ((messages || []).some(m => (m.messageType === 'image' || m.messageType === 'audio') && m.mediaUrl)) return false
  if (!t) return true
  // Attachment-only messages (stickers, reels, photos, story mentions) arrive as '[media]' markers
  if (/^(\[media\]\s*)*\[media\]$/.test(t)) return true
  // Story replies/mentions (tagged by the webhook handler)
  if (messages && messages.length > 0 && messages.every(m => m.messageType === 'ig_story_reply')) return true
  // Emoji/sticker/reaction-only (includes 🙏-only)
  if (isEmojiOnly(t)) return true
  // Bare greetings — normalize like the WhatsApp filters do (strip emojis, punctuation, honorifics)
  const normalized = t.toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, '')
    .replace(/[.!?,।]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(sir|ji|bhai|bhaiya|boss|bro)$/, '')
    .trim()
  if (ZERO_GREETINGS.has(normalized)) return true
  if (/^h+i+$/.test(normalized) || /^he+y+$/.test(normalized) || /^hel+o+$/.test(normalized)) return true
  return false
}

function hasBuyerIntent(mergedText) {
  const lower = (mergedText || '').toLowerCase()
  return BUYER_INTENT_KEYWORDS.some(kw => lower.includes(kw))
}

/**
 * Decide the tier for an incoming IG message burst.
 * Returns one of:
 *   { action: 'skip',  reason }               — log SKIPPED, no reply, no AI
 *   { action: 'canned', reason, cannedText }  — send canned text, log REPLIED at 0 cost
 *   { action: 'ai',    reason }               — proceed to the full AI pipeline
 */
export async function evaluateIgGate({ db, conversationId, mergedText, messages }) {
  // 24h window guard — trivially fresh for live webhooks, protects buffered/retried edge cases
  const newestTs = (messages || [])
    .map(m => new Date(m.timestamp || 0).getTime())
    .filter(ts => Number.isFinite(ts) && ts > 0)
    .reduce((a, b) => Math.max(a, b), 0)
  if (newestTs && Date.now() - newestTs > IG_24H_MS) {
    return { action: 'skip', reason: 'ig_window_expired' }
  }

  // --- ZERO tier ---
  if (isZeroTier(mergedText, messages)) {
    return { action: 'skip', reason: 'ig_zero_tier' }
  }

  // --- NUDGE TIER DELETED 2026-07-28 (Ketu: "All the Instagram messages should be considered
  // as WhatsApp messages and should get the same kind of reply") ---
  // It gated real answers behind an ALLOW-LIST of buyer keywords, so any ordinary English
  // question that happened to use none of them was answered with a canned pointer instead.
  // Measured over Instagram's first 9.2 hours live: 8 messages fell to this tier across 3
  // buyers, and 7 of the 8 were genuine business questions — "Where is your company located"
  // (Ira, twice — the second ask got total silence), "What would the minimum quantity be?",
  // "Hello Contact number", and a quality complaint "Ek wash me ye halat he t shirt ka" that
  // missed only because he typed "t shirt" with a space. All 3 buyers then had to be answered
  // by Ketu by hand. Widening the keyword list on the same day did not save it: replaying those
  // 8 messages against the widened list still nudged 6 of 8. An allow-list cannot enumerate how
  // people ask things — that is the design flaw, not a tuning problem.
  // It also saved nothing worth having: an IG answer costs $0.0333 (₹2.93), within 4% of a
  // WhatsApp answer, so the tier protected ₹2.93 of chatter while blocking ₹23 of real answers.
  // Spend stays bounded by the caps below, the ZERO tier above (emoji/media/bare greeting), and
  // the global daily budget in process.js.
  // hasBuyerIntent()/BUYER_INTENT_KEYWORDS are kept ONLY to label the reason for the logs.
  let established = null
  try {
    established = await db.messageLog.findFirst({
      where: { conversationId, status: 'REPLIED', totalTokens: { gt: 0 } },
      select: { id: true },
    })
  } catch (err) {
    console.error('[IG Gate] established-buyer lookup failed (treating as new):', err.message)
  }

  // --- CAPS (checked BEFORE any paid AI call): per-user 10/day + global IG 100/day, IST ---
  const dayStart = istDayStart()
  const [userAiToday, globalIgAiToday] = await Promise.all([
    db.messageLog.count({
      where: { conversationId, status: 'REPLIED', totalTokens: { gt: 0 }, createdAt: { gte: dayStart } },
    }),
    db.messageLog.count({
      where: {
        status: 'REPLIED', totalTokens: { gt: 0 }, createdAt: { gte: dayStart },
        conversation: { whatsappNumber: { startsWith: 'ig:' } },
      },
    }),
  ])
  if (userAiToday >= IG_PER_USER_DAILY_AI_CAP || globalIgAiToday >= IG_GLOBAL_DAILY_AI_CAP) {
    const capScope = userAiToday >= IG_PER_USER_DAILY_AI_CAP ? 'user' : 'global'
    const recentCapNudge = await db.messageLog.findFirst({
      where: {
        conversationId,
        deferReason: 'ig_cap_nudge',
        createdAt: { gte: new Date(Date.now() - IG_24H_MS) },
      },
      select: { id: true },
    })
    if (recentCapNudge) return { action: 'skip', reason: `ig_over_cap_${capScope}` }
    return { action: 'canned', reason: 'ig_cap_nudge', cannedText: IG_CAP_TEXT }
  }

  return {
    action: 'ai',
    reason: established ? 'ig_established_buyer' : (hasBuyerIntent(mergedText) ? 'ig_buyer_intent' : 'ig_open_tier'),
  }
}
