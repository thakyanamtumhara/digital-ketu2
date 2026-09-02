// RECONCILE AGAINST wwbun'S INBOX (2026-09-02).
//
// The wwbun → dk2 hand-off is a single fire-and-forget POST (/api/incoming) that fires ~200 lines
// AFTER wwbun has saved the message, behind several awaited DB steps, with a 15s timeout and no
// retry. Anything that breaks in between — a DB hiccup, a slow dk2 boot, a deploy — leaves the
// message safely stored in wwbun and NEVER seen by the clone; Meta's redelivery is then rejected
// by wwbun as a duplicate. That is how buyer 9818070935's "Bhai shorts ka stock refill kab kroge"
// vanished on 2026-08-31 (the clone answered the next message about the wrong product; Ketu had
// to answer the real one). Nothing in dk2 could have caught it: there was no row, no error.
//
// So dk2 now treats wwbun's inbox as the source of truth and reconciles against it:
//   1. per burst — right before a burst is processed, pull the buyer's inbound messages of the
//      last few minutes and merge any the clone never received, in timestamp order;
//   2. per sweep — every 2 minutes, pull recent inbound across all buyers and enqueue anything
//      that never reached dk2 at all (a lost message with no sibling to trigger a burst).
// Both are FAIL-OPEN: any fetch error → nothing changes, the old behaviour stands.
// Double-reply guard: an in-memory seen-set of every message id dk2 has accepted (via
// /api/incoming or reconciliation) for 30 min, plus the messageLog ids for anything older.

const WWBUN_API_URL = (process.env.WWBUN_API_URL || '').replace(/\/+$/, '')
const DIGITAL_KETU_SECRET = process.env.DIGITAL_KETU_SECRET

// Never re-feed these even if wwbun's filter misses them (review 2026-09-02): reminder-button taps
// are answered by wwbun's reengage engine, and the operator's own number is not a buyer.
const BUTTON_TEXTS = new Set(['send me stock updates', 'stop messages'])
// Same derivation wwbun uses for OWNER_COMMAND_NUMBERS, same default.
const OPERATOR_LAST10 = (process.env.OWNER_COMMAND_NUMBERS || '8527150400').split(',').map(s => s.replace(/\D/g, '').slice(-10)).filter(Boolean)
export function isExcludedRow(r) {
  const txt = String(r && r.content || '').trim().toLowerCase()
  if (BUTTON_TEXTS.has(txt)) return true
  if (txt === '[sticker]') return true                    // wwbun stores stickers as IMAGE '[Sticker]'; not worth a reply
  const num = String(r && r.whatsappNumber || '').replace(/\D/g, '')
  return OPERATOR_LAST10.some(n => num.endsWith(n))
}

// ---- burst integrity: carry a pending defer, split a partial defer ----
// THE 2026-08-31 LOSS, FOR REAL (audit trace 2026-09-02, from the production log): "Bhai shorts ka
// stock refill kab kroge" DID reach dk2; the model deferred it (correctly — a Ketu-only timing
// question) and the holding line was queued on the 30s defer batch. The next message arrived,
// became its own burst, was answered — and just before that send, cancelPendingDefer() deleted the
// queued defer: no holding line, no log row, no carry. The buyer got an answer to the wrong
// product and nothing at all for the real question. Two rules now:
//  1. A pending, unanswered defer is CARRIED into the next burst as a synthetic message (same
//     pattern as the welcome swallow-carry), so the model reads both questions together and one
//     holding line covers whatever it still cannot answer.
//  2. A reply may be PARTIAL: text + a [DEFER] marker means "send this, and hold the rest" — the
//     answerable part goes out now, the holding line follows for the rest, and the question lands
//     in Ketu's Waiting list. Before this, ANY [DEFER] collapsed the whole reply into a holding line.
export function syntheticFromPendingDefer(entry, incomingText = '') {
  const msgs = (entry && entry.messages) || []
  const texts = msgs.map(m => String(m.mergedText || '').trim()).filter(Boolean)
  const text = texts.join('\n')
  if (!text) return null
  // An identical re-send still hands the burst OWNERSHIP of the hold (ids + entry), but carries no
  // text — the real message already says it once. Otherwise a model answer to the re-send would be
  // followed by the stale holding line 30s later (review 2026-09-02).
  const identical = text === String(incomingText || '').trim()
  const carriedMessageIds = msgs.flatMap(m => m.messageIds || []).filter(Boolean)
  const carriedAnswered = msgs.map(m => m.answered).filter(Boolean).join('\n') || null
  return {
    messageText: identical ? '' : text, messageId: null, carriedMessageIds, carriedDefer: true, carriedAnswered,
    // The original entry rides along so the burst can RE-QUEUE it if it ends without a reply or a
    // fresh defer (model [SKIP], gate SILENT, a filter skip…) — a carried question must never die
    // on a silent exit (review 2026-09-02).
    deferEntry: { messages: msgs, deferMessage: entry && entry.deferMessage, db: entry && entry.db, brainLabel: (entry && entry.brainLabel) || null },
    messageType: 'text', hasMedia: false, timestamp: new Date(0).toISOString(),   // epoch → pinned first by orderBurst
    senderName: null, quotedText: null, mediaUrl: null, wwbunMessageId: null,
  }
}

const DEFER_MARK_RE = /\[DEFER\]/g
// Text the model sometimes writes NEXT TO the marker that is narration, not an answer for the buyer.
// A bare defer (holding line only) is the safe outcome for these (review 2026-09-02).
const DEFER_NARRATION_RE = /^(this|that|it|the (buyer|customer|user|message)) (is|looks|seems|needs|requires)\b|\b(I|we) (cannot|can'?t|can not|am unable to|need to|will) (handle|check|answer|look|see|verify|track|help)\b|\bneeds? ketu\b|\bwhich (I|we) (cannot|can'?t)\b|ketu\s+will\s+reply\s+shortly|ketu\s+(bhai\s+)?(reply|batayenge|check)/i
export function partialDeferSplit(aiReply) {
  const raw = String(aiReply || '')
  if (!DEFER_MARK_RE.test(raw)) return { isDefer: false, isPartial: false, text: raw }
  DEFER_MARK_RE.lastIndex = 0
  const text = raw.replace(DEFER_MARK_RE, '').replace(/[ \t]+\n/g, '\n').trim()
  const words = text.split(/\s+/).filter(Boolean).length
  // A real answer has a few words and is not narration / a holding line of its own.
  const isPartial = words >= 3 && !DEFER_NARRATION_RE.test(text)
  return { isDefer: true, isPartial, text: isPartial ? text : '' }
}

// ---- seen-set ----
export const SEEN_TTL_MS = 30 * 60 * 1000
const seen = new Map()   // messageId → first-seen epoch ms
export function markSeen(id) { if (id) seen.set(id, Date.now()) }
export function wasSeen(id) {
  if (!id) return false
  const t = seen.get(id)
  if (t === undefined) return false
  if (Date.now() - t > SEEN_TTL_MS) { seen.delete(id); return false }
  return true
}
export function pruneSeen(now = Date.now()) {
  for (const [id, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(id)
  return seen.size
}

// ---- wwbun fetch ----
// GET /api/dk/recent-inbound?minutes=N[&number=X] → [{ id, whatsappId, content, messageType,
// mediaUrl, createdAt, whatsappNumber }] (inbound only, newest last). Served by wwbun ≥ 2026-09-02.
let warnedNoConfig = false
export async function fetchRecentInbound({ number = null, minutes = 10, timeoutMs = 6000 } = {}) {
  if (!WWBUN_API_URL || !DIGITAL_KETU_SECRET) {
    if (!warnedNoConfig) { warnedNoConfig = true; console.error('[Reconcile] WWBUN_API_URL / DIGITAL_KETU_SECRET not set — inbox reconciliation is OFF') }
    return []
  }
  try {
    const q = new URLSearchParams({ minutes: String(minutes) })
    if (number) q.set('number', number)
    const res = await fetch(`${WWBUN_API_URL}/api/dk/recent-inbound?${q}`, {
      headers: { 'X-Digital-Ketu-Secret': DIGITAL_KETU_SECRET },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) { console.error(`[Reconcile] recent-inbound HTTP ${res.status} (ignored)`); return [] }
    const rows = await res.json()
    return Array.isArray(rows) ? rows : []
  } catch (err) {
    console.error('[Reconcile] recent-inbound fetch failed (ignored):', err.message)
    return []
  }
}

// Shape a wwbun inbox row like a forwarded /api/incoming message.
export function rowToMessage(r) {
  const type = String(r.messageType || 'TEXT').toUpperCase()
  return {
    messageText: r.content || '',
    messageId: r.whatsappId,
    messageType: type.toLowerCase(),
    hasMedia: ['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'].includes(type),
    timestamp: r.createdAt || new Date().toISOString(),
    senderName: null,
    quotedText: null,
    mediaUrl: r.mediaUrl || null,
    wwbunMessageId: r.id || null,
    reconciled: true,
  }
}

// Pure merge: add inbox rows the burst does not already hold and that dk2 has not seen/logged,
// then order everything by timestamp so the model reads the conversation as the buyer wrote it.
// `isKnown(whatsappId)` answers "has dk2 already accepted or logged this id?".
// Timestamp order for a burst: real messages sorted by their WhatsApp timestamp (stable, so
// same-second ties keep arrival order); synthetic carried entries (messageId null — the swallowed
// greeting) stay pinned at the front, where the swallow-fix put them.
export function orderBurst(messages) {
  const pinned = (messages || []).filter(m => !m.messageId)
  const real = (messages || []).filter(m => m.messageId)
  const ts = m => new Date(m.timestamp || 0).getTime() || 0
  real.sort((a, b) => ts(a) - ts(b))
  return [...pinned, ...real]
}

export function mergeUnseenInbound(burst, rows, isKnown) {
  const have = new Set((burst || []).map(m => m.messageId).filter(Boolean))
  const added = []
  for (const r of rows || []) {
    const id = r && r.whatsappId
    if (!id || have.has(id) || isKnown(id) || isExcludedRow(r)) continue
    have.add(id)
    added.push(rowToMessage(r))
  }
  return { messages: orderBurst([...(burst || []), ...added]), added }
}

// Sweep filter: which inbox rows (across buyers) should be enqueued as brand-new bursts?
// Old enough that the normal forward (and its retries) has clearly had its chance; the upper
// bound equals the seen-set TTL so the dedupe memory always covers the whole window. Note wwbun's
// createdAt is Meta's SEND time — a phone that was offline can deliver minutes late, which is why
// the window is 30 min and not 6.
export function pickSweepCandidates(rows, isKnown, { now = Date.now(), minAgeMs = 90 * 1000, maxAgeMs = SEEN_TTL_MS } = {}) {
  const out = []
  for (const r of rows || []) {
    const id = r && r.whatsappId
    const num = String(r && r.whatsappNumber || '')
    if (!id || !/^\d{10,15}$/.test(num)) continue          // WhatsApp buyers only (no ig:, no blanks)
    if (isExcludedRow(r)) continue
    const age = now - (new Date(r.createdAt || 0).getTime() || 0)
    if (age < minAgeMs || age > maxAgeMs) continue
    if (isKnown(id)) continue
    out.push({ number: num, message: rowToMessage(r) })
  }
  return out
}
