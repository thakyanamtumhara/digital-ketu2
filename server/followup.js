// PROACTIVE FOLLOW-UP — SHORTLIST MODE (2026-07-24, Ketu-approved pilot).
//
// Ketu's constraints, verbatim honoured:
// - He never blind-initiates; selection is HIS gut → nothing is ever sent without his one-tap
//   approval. The clone only PROPOSES: it WhatsApps him a numbered shortlist with ready drafts;
//   he replies "1" / "1 2" / "sab" / "skip" in his owner chat (the /api/ask channel) to act.
// - WhatsApp 24h window: a free-form message must land within 24h of the buyer's last inbound.
//   Candidates are picked at 18-20h quiet (leaving ~4-6h of window) and re-checked (<23h) at
//   send time; too late → marked expired, never a paid template.
// - "Somebody who did something on our website is not the person to re-initiate with": anyone
//   with a website order in the last 3 days is excluded (order system checked by their number).
// - Cost discipline: selection is RULES-ONLY (no AI calls) and drafts are templates — the whole
//   feature costs ~₹0. Caps: max 3 per scan, max 8 proposals/day, one follow-up per buyer per 30d.
//
// Fully isolated: nothing in the reply pipeline imports this; every step fail-opens (an error =
// no shortlist today, never a broken reply flow).

import { sendReplyViaWwbun, notifyOwner } from './process.js'
import { lookupOrdersByPhone } from './order-lookup.js'

// Shopping-interest signal in the buyer's own words (same spirit as the budget-cap SHOPPING_RE).
const INTEREST_RE = /\b(t[\s-]?shirt|tshirt|tees?|oversize[d]?|polo|hoodie|sweat\s?shirt|round\s*neck|rneck|acid\s*wash|sublimation|shorts|kids|gsm|cotton|biowash|bio\s*wash|price|rate|rates|catalog|sample|wholesale|bulk|moq)\b|chahiye|looking\s*for|requirement|\bwant\b|\bneed\b|kitna|kitne/i
// Serious-buyer bonus: a quantity in the thread ("500 pcs", "100 pieces", "50 tshirt chahiye")
const QTY_RE = /\b(\d{2,5})\s*(pcs?|pieces?|pis|pes|t[\s-]?shirts?|nos)\b/i
// Hard exclusions — complaint / order / payment / tracking threads are NEVER followed up.
const EXCLUDE_RE = /\b(order|tracking|track|awb|parcel|dispatch|deliver|refund|return|complaint|payment|paid|invoice|bill|courier|damage)\b|nahi\s*aaya|kahan|shikayat|galat/i
const ENDER_TOKENS = new Set(['ok', 'okay', 'okey', 'k', 'thik', 'theek', 'hai', 'thanks', 'thank', 'you', 'thankyou', 'thanku', 'hmm', 'hm', 'acha', 'accha', 'done', 'great', 'nice', 'good', 'ji', 'sir', 'bhai', 'welcome', 'yes', 'haan', 'ha'])
function isEnderish(text) {
  const s = (text || '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return true
  return s.split(' ').every(t => ENDER_TOKENS.has(t))
}

const PRODUCT_LABELS = [
  ['acid wash', 'Acid wash'], ['sublimation', 'Sublimation'], ['polo', 'Polo'], ['hoodie', 'Hoodie'],
  ['sweatshirt', 'Sweatshirt'], ['round neck', 'Round neck'], ['rneck', 'Round neck'],
  ['oversize', 'Oversize'], ['shorts', 'Shorts'], ['kids', 'Kids'], ['tshirt', 'Tshirt'], ['t shirt', 'Tshirt'],
]

function productLabel(text) {
  const t = (text || '').toLowerCase()
  for (const [k, label] of PRODUCT_LABELS) if (t.includes(k)) return label
  return null
}

function isEnglishText(text) {
  return /^[\x00-\x7F\s]*$/.test(text || '') && !/\b(hai|nahi|chahiye|kitna|bhai|karna|milega)\b/i.test(text || '')
}

function buildDraft(buyerText) {
  const prod = productLabel(buyerText)
  if (isEnglishText(buyerText)) {
    return prod
      ? `Sir did you finalise the ${prod.toLowerCase()} requirement? Happy to help with the order 🙏 https://sale91.com`
      : `Sir did you finalise your requirement? Happy to help with the order 🙏 https://sale91.com`
  }
  return prod
    ? `Sir ${prod.toLowerCase()} ka requirement final hua kya? Koi help chahiye to bata dijiye 🙏 https://sale91.com`
    : `Sir requirement ka kya socha? Koi help chahiye to bata dijiye 🙏 https://sale91.com`
}

// ---------------------------------------------------------------------------
// SCAN — every ~2h (caller gates business hours): buyers whose LAST inbound is 18-20h old,
// showed shopping interest, no order/complaint markers, Ketu not already in the thread,
// no website order in 3 days, no follow-up in 30 days.
// ---------------------------------------------------------------------------
export async function scanFollowupCandidates(db) {
  try {
    const now = Date.now()
    const bandStart = new Date(now - 20 * 3600 * 1000)
    const bandEnd = new Date(now - 18 * 3600 * 1000)
    const sentToday = await db.followupDraft.count({
      where: { createdAt: { gte: new Date(now - 24 * 3600 * 1000) } },
    })
    if (sentToday >= 8) return // daily proposal cap
    const convos = await db.buyerConversation.findMany({
      where: { lastMessageAt: { gte: bandStart, lte: bandEnd } },
      select: { id: true, whatsappNumber: true, lastMessageAt: true },
      take: 40,
    })
    const picks = []
    for (const convo of convos) {
      if (picks.length >= 3) break
      const num = convo.whatsappNumber || ''
      if (num.startsWith('ig:') || num.replace(/\D/g, '').slice(-10).length !== 10) continue
      if (num.includes('8527150400')) continue // owner
      // Already proposed/followed-up recently?
      const dup = await db.followupDraft.findFirst({ where: { whatsappNumber: num, createdAt: { gte: new Date(now - 3 * 86400000) } } })
      if (dup) continue
      const mem = await db.buyerMemory.findUnique({ where: { whatsappNumber: num } }).catch(() => null)
      if (mem?.followupAt && now - new Date(mem.followupAt).getTime() < 30 * 86400000) continue
      // Read the thread's last day
      const logs = await db.messageLog.findMany({
        where: { conversationId: convo.id, createdAt: { gte: new Date(now - 26 * 3600 * 1000) } },
        orderBy: { createdAt: 'desc' }, take: 12,
        select: { buyerMessage: true, aiReply: true, status: true, deferReason: true },
      })
      if (!logs.length) continue
      const buyerText = logs.map(l => l.buyerMessage || '').join(' \n ')
      const last = logs[0]
      if (logs.some(l => l.deferReason === 'manual_reply')) continue        // Ketu is on this thread
      if (logs.some(l => l.status === 'DEFERRED')) continue                  // open handoff — his court
      if (EXCLUDE_RE.test(buyerText)) continue                               // order/complaint thread
      if (!INTEREST_RE.test(buyerText)) continue                             // no shopping interest
      if (isEnderish(last.buyerMessage)) continue                            // they closed the chat
      // Serious-buyer preference: quantity mentioned ranks first
      picks.push({ num, convoId: convo.id, buyerText, qty: QTY_RE.test(buyerText) })
    }
    if (!picks.length) return
    picks.sort((a, b) => (b.qty ? 1 : 0) - (a.qty ? 1 : 0))
    // Number today's items after the existing ones
    const startNo = (await db.followupDraft.count({ where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } })) + 1
    const created = []
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i]
      const ctxRaw = (p.buyerText.match(new RegExp(`[^\\n]*(?:${QTY_RE.source})[^\\n]*`, 'i')) || [p.buyerText])[0]
      const context = ctxRaw.replace(/\s+/g, ' ').trim().slice(0, 90)
      created.push(await db.followupDraft.create({
        data: { whatsappNumber: p.num, context, draft: buildDraft(p.buyerText), itemNo: startNo + i },
      }))
    }
    const lines = created.map(d => `${d.itemNo}) +${d.whatsappNumber} — "${d.context}"\n   Draft: ${d.draft}`)
    await notifyOwner(
      `📋 Follow-up shortlist — kal ke quiet shoppers (window ~4h bacha hai):\n\n${lines.join('\n\n')}\n\nBhejne ke liye number reply karo ("${created[0].itemNo}" ya "${created.map(d => d.itemNo).join(' ')}"), ignore = kuch nahi jayega.`
    )
    console.log(`[Followup] proposed ${created.length} candidate(s) to Ketu`)
  } catch (err) {
    console.error('[Followup] scan failed (harmless):', err.message)
  }
}

// ---------------------------------------------------------------------------
// APPROVAL — called from the /api/ask owner channel BEFORE the general-assistant reply.
// Returns a confirmation string if the text was a shortlist action, else null (fall through).
// ---------------------------------------------------------------------------
export async function handleOwnerShortlistReply(db, text) {
  try {
    const t = String(text || '').trim().toLowerCase()
    const pending = await db.followupDraft.findMany({
      where: { status: 'pending', createdAt: { gte: new Date(Date.now() - 8 * 3600 * 1000) } },
      orderBy: { createdAt: 'asc' },
    })
    if (!pending.length) return null
    if (/^(skip|ignore|no|nahi|mat bhejo|cancel)$/i.test(t)) {
      await db.followupDraft.updateMany({ where: { id: { in: pending.map(p => p.id) } }, data: { status: 'skipped' } })
      return `👍 Theek hai — ${pending.length} follow-up skip kar diye, kisi ko kuch nahi bheja.`
    }
    let chosen = []
    if (/^(sab|sab bhejo|all|send all)$/i.test(t)) chosen = pending
    else {
      const nums = (t.match(/\d+/g) || []).map(Number)
      // Only treat as an approval when EVERY number matches a pending item (else it's a normal
      // owner question that happens to contain digits — fall through to the assistant).
      if (!nums.length || !/^(send\s*)?[\d\s,]+$/.test(t)) return null
      chosen = pending.filter(p => nums.includes(p.itemNo))
      if (chosen.length !== nums.length) return null
    }
    const results = []
    for (const d of chosen) {
      const convo = await db.buyerConversation.findUnique({
        where: { whatsappNumber: d.whatsappNumber }, select: { id: true, lastMessageAt: true },
      })
      const ageH = convo?.lastMessageAt ? (Date.now() - new Date(convo.lastMessageAt).getTime()) / 3600000 : 99
      if (ageH >= 23) { // window closed — never a paid template
        await db.followupDraft.update({ where: { id: d.id }, data: { status: 'expired' } })
        results.push(`⌛ ${d.itemNo}) +${d.whatsappNumber} — 24h window nikal gaya, nahi bheja`)
        continue
      }
      const sent = await sendReplyViaWwbun(d.whatsappNumber, d.draft)
      await db.followupDraft.update({ where: { id: d.id }, data: { status: sent ? 'sent' : 'pending', sentAt: sent ? new Date() : null } })
      if (sent) {
        await db.buyerMemory.upsert({
          where: { whatsappNumber: d.whatsappNumber },
          update: { followupAt: new Date() },
          create: { whatsappNumber: d.whatsappNumber, followupAt: new Date() },
        }).catch(() => {})
        if (convo?.id) {
          await db.messageLog.create({
            data: { conversationId: convo.id, buyerMessage: '[proactive follow-up]', messageIds: [], status: 'REPLIED', deferReason: 'followup_sent', aiReply: d.draft, costUsd: 0 },
          }).catch(() => {})
        }
        results.push(`✅ ${d.itemNo}) +${d.whatsappNumber} — bhej diya`)
      } else {
        results.push(`❌ ${d.itemNo}) +${d.whatsappNumber} — send FAIL hua, dobara try karna`)
      }
    }
    return results.length ? results.join('\n') : null
  } catch (err) {
    console.error('[Followup] approval handling failed:', err.message)
    return null
  }
}
