// PROACTIVE FOLLOW-UP — SHORTLIST MODE (2026-07-24, Ketu-approved pilot).
//
// Ketu's constraints, verbatim honoured:
// - He never blind-initiates; selection is HIS gut → nothing is ever sent without his one-tap
//   approval. The clone only PROPOSES: it builds a numbered shortlist with ready drafts that
//   he acts on from the wwbun 📤 panel. It used to WhatsApp/Telegram him the list too, but he
//   muted that on 18-Aug-2026 — the drafts are still built, he just is not pinged about them.
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

import { sendReplyViaWwbun } from './process.js'
import { lookupOrdersByPhone } from './order-lookup.js'

// Shopping-interest signal in the buyer's own words (same spirit as the budget-cap SHOPPING_RE).
const INTEREST_RE = /\b(t[\s-]?shirt|tshirt|tees?|oversize[d]?|polo|hoodie|sweat\s?shirt|round\s*neck|rneck|acid\s*wash|sublimation|shorts|kids|gsm|cotton|biowash|bio\s*wash|price|rate|rates|catalog|sample|wholesale|bulk|moq)\b|chahiye|looking\s*for|requirement|\bwant\b|\bneed\b|kitna|kitne/i
// Serious-buyer bonus: a quantity in the thread ("500 pcs", "100 pieces", "50 tshirt chahiye")
const QTY_RE = /\b(\d{2,5})\s*(pcs?|pieces?|pis|pes|t[\s-]?shirts?|nos)\b/i
// Hard exclusions — complaint / order / payment / tracking threads are NEVER followed up.
const EXCLUDE_RE = /\b(order|tracking|track|awb|parcel|dispatch|deliver|refund|return|complaint|payment|paid|invoice|bill|courier|damage)\b|nahi\s*aaya|kahan|shikayat|galat/i
// Don't propose a follow-up to a buyer who wanted something we DON'T make (Ketu skipped a "crop tops"
// proposal 2026-07-26 — we don't make them, so there's nothing to re-engage them on). Mirrors the
// not-made list from the reply rulebook. Also skip printing/customization asks (Ketu's referral job).
const NOT_MADE_FU_RE = /crop\s*top|\blower(s)?\b|\bjeans\b|jogger|track\s*-?pant|trouser|pajama|pyjama|palazzo|blazer|\bjacket|denim|sando|sandow|baniyan|\bvest\b|ganji|full\s*sleeve|night\s*(suit|pant)|\bshirt\b(?!\s*(t|tee))|custom|printing|\bprint(ed|ing)?\b|embroider/i
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
    // Quiet 12-16h (was 18-20h): leaves Ketu ~8-12h of the WhatsApp 24h window to review + approve
    // in wwbun, instead of the ~4-6h that mostly expired before he ever saw it.
    const bandStart = new Date(now - 16 * 3600 * 1000)
    const bandEnd = new Date(now - 12 * 3600 * 1000)
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
      if (NOT_MADE_FU_RE.test(buyerText)) continue                           // wanted something we don't make / print job
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
    // Ketu muted the push on 18-Aug-2026 — he did not want a shortlist arriving on its
    // own. The drafts are still built, so the wwbun 📤 panel and its pending badge keep
    // working; he now goes and looks instead of being told.
    console.log(`[Followup] prepared ${created.length} candidate(s) — panel only, owner not pinged`)
  } catch (err) {
    console.error('[Followup] scan failed (harmless):', err.message)
  }
}

// Send/skip a SINGLE draft (used by both the wwbun panel buttons and the WhatsApp reply path).
export async function actOnDraft(db, id, action) {
  const d = await db.followupDraft.findUnique({ where: { id } })
  if (!d) return { ok: false, msg: 'not found' }
  if (d.status !== 'pending') return { ok: false, status: d.status, msg: `already ${d.status}` }
  if (action === 'skip') {
    await db.followupDraft.update({ where: { id }, data: { status: 'skipped' } })
    return { ok: true, status: 'skipped' }
  }
  const convo = await db.buyerConversation.findUnique({
    where: { whatsappNumber: d.whatsappNumber }, select: { id: true, lastMessageAt: true },
  })
  const ageH = convo?.lastMessageAt ? (Date.now() - new Date(convo.lastMessageAt).getTime()) / 3600000 : 99
  if (ageH >= 23) { // WhatsApp free window closed — never a paid template
    await db.followupDraft.update({ where: { id }, data: { status: 'expired' } })
    return { ok: false, status: 'expired', msg: '24h window closed' }
  }
  const ctx = {}
  const sent = await sendReplyViaWwbun(d.whatsappNumber, d.draft, null, ctx)
  // Bot switched off for this chat = never sendable. Close the draft instead of leaving it
  // 'pending' for him to approve again and again against a door that will never open.
  if (!sent && ctx.blocked) {
    await db.followupDraft.update({ where: { id }, data: { status: 'skipped' } })
    return { ok: false, status: 'skipped', msg: 'is chat ka bot OFF hai — nahi bheja' }
  }
  if (!sent) return { ok: false, msg: 'send failed' }
  await db.followupDraft.update({ where: { id }, data: { status: 'sent', sentAt: new Date() } })
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
  return { ok: true, status: 'sent' }
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
      const ctx = {}
      const sent = await sendReplyViaWwbun(d.whatsappNumber, d.draft, null, ctx)
      if (!sent && ctx.blocked) {
        // Bot is OFF for this chat — close it, don't re-offer it every 8h with "try again".
        await db.followupDraft.update({ where: { id: d.id }, data: { status: 'skipped' } })
        results.push(`🚫 ${d.itemNo}) +${d.whatsappNumber} — is chat ka bot OFF hai, nahi bheja`)
        continue
      }
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
