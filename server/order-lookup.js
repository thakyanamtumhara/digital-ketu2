// Read-only order/tracking lookup — closes the clone's #1 defer bucket ("is my order
// dispatched / tracking id / order kahan hai", 16+ deferrals in the 2026-07-16 audit).
// Queries the same rustpostgres REST service the WOD dashboard uses (SELECT-only), then
// booking_logs for the AWB, and returns a buyer-safe tracking link (trq.pages.dev — the
// sanitized buyer-facing tracker; never expose courier-account/sender details).
//
// SECURITY INVARIANTS:
// - We ONLY look up the asking buyer's own WhatsApp number — never a number parsed from
//   the message text (prevents "what did buyer 98xxx order" social-engineering).
// - Phone is reduced to exactly 10 digits and odids are charset-stripped before being
//   interpolated into SQL, so no injection vector exists.
// - SELECT-only; any error returns null and the caller falls back to today's [DEFER].

const RUSTPOSTGRES_URL = process.env.RUSTPOSTGRES_URL || 'https://rustpostgres-production.up.railway.app'
const DB_API_KEY = process.env.DB_API_KEY || 'Railway345789@com'

async function dbQuery(sql) {
  const res = await fetch(`${RUSTPOSTGRES_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': DB_API_KEY },
    body: JSON.stringify({ sql }),
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) throw new Error(`rustpostgres ${res.status}`)
  const j = await res.json()
  return j.rows || []
}

// AWB heuristic: booking_logs.error_booking holds EITHER the AWB (compact alphanumeric)
// OR an error sentence. Only treat compact tokens as an AWB.
function looksLikeAwb(s) {
  return typeof s === 'string' && /^[A-Za-z0-9-]{8,25}$/.test(s.trim())
}

// THE AWB STRING ENCODES THE COURIER, and each courier has its OWN tracking page. This used to
// hardcode trq.pages.dev for every AWB, but trq is the DELHIVERY-DIRECT page only: its worker reads
// search[1] as the account prefix (a/b/c → dl0/dl1/dl2) and returns "Not Found" for anything else.
// So every ShipRocket order got a 404 link. Caught live 2026-08-01 19:03 — the clone sent
// trq.pages.dev/?77103029172 (404) and Ketu had to resend shiprocket.co/tracking/77103029172.
//   Delhivery  → prefixed a/b/c        → trq.pages.dev/?<awb>
//   RocketBox  → trailing '&'          → app-cargo.shiprocket.in (strip the '&'; dp_name=Delhivery)
//   ShipRocket → raw, no prefix/suffix → shiprocket.co/tracking/<awb>
function trackUrlFor(awb) {
  const s = String(awb || '').trim()
  if (!s) return null
  if (s.endsWith('&')) {
    return `https://app-cargo.shiprocket.in/p/track-shipment?dp_name=Delhivery&waybillno=${s.slice(0, -1)}`
  }
  if (/^[abc]/i.test(s)) return `https://trq.pages.dev/?${s}`
  return `https://shiprocket.co/tracking/${s}`
}

function courierLabel(o) {
  const tch = String(o.tch || '')
  if (/zz\d/i.test(tch)) return 'Delhivery'
  if (o.cstcr) return String(o.cstcr)          // manual/custom courier as recorded
  if (tch.includes(',')) return 'Cargo/LTL'
  return 'Courier'                              // Shiprocket books under many couriers — stay generic
}

export async function lookupOrdersByPhone(whatsappNumber) {
  const digits = String(whatsappNumber || '').replace(/\D/g, '').slice(-10)
  if (digits.length !== 10) return null
  const orders = await dbQuery(
    `SELECT odid, nm, mn1, mn2, dt, status, tch, tchmth, cstcr, shpid
     FROM orders
     WHERE mn1 LIKE '%${digits}%' OR mn2 LIKE '%${digits}%' OR b::text LIKE '%${digits}%'
     ORDER BY dt DESC LIMIT 4`
  )
  if (!orders.length) return []
  const out = []
  for (const o of orders.slice(0, 3)) {
    const odidSafe = String(o.odid || '').replace(/[^A-Za-z0-9_~-]/g, '')
    if (!odidSafe) continue
    let awb = null
    try {
      const logs = await dbQuery(
        `SELECT error_booking, created_at FROM booking_logs
         WHERE id LIKE '${odidSafe}%' ORDER BY created_at DESC LIMIT 3`
      )
      awb = (logs.map(l => l.error_booking).find(looksLikeAwb) || '').trim() || null
    } catch { /* booking log miss → treat as not-booked */ }
    out.push({
      odid: odidSafe,
      shortId: odidSafe.replace(/^BillNo_/i, ''),
      date: o.dt ? new Date(Number(o.dt) || o.dt).toISOString().slice(0, 10) : null,
      awb,
      courier: awb ? courierLabel(o) : null,
      trackUrl: trackUrlFor(awb),
    })
  }
  return out
}

// ===========================================================================
// BUYER PROFILE (2026-07-21, Ketu-approved roadmap step: "makes the clone sound like it REMEMBERS
// a returning buyer"). Injected on EVERY turn (not just tracking intent) — a compact ~60-token
// line: order count, last order (products + value + date), booking state of the newest order.
// Same security invariants as the lookup above: buyer's OWN number only, read-only, fail-open
// (any error → null → no block → behaviour identical to before).
// ===========================================================================

const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000
const _profileCache = new Map() // digits → { at, profile }

// od JSONB: {"Product":{"Colour":{"Size":qty}}} → "Product (Colour, Colour)" summary, max 3 products
function summarizeOd(od) {
  if (!od || typeof od !== 'object') return null
  const parts = []
  for (const product of Object.keys(od).slice(0, 3)) {
    const colours = od[product] && typeof od[product] === 'object' ? Object.keys(od[product]).slice(0, 3) : []
    parts.push(colours.length ? `${product} (${colours.join(', ')})` : product)
  }
  if (Object.keys(od).length > 3) parts.push('…')
  return parts.join(' + ') || null
}

export async function getBuyerProfile(whatsappNumber) {
  const digits = String(whatsappNumber || '').replace(/\D/g, '').slice(-10)
  if (digits.length !== 10) return null
  const hit = _profileCache.get(digits)
  if (hit && Date.now() - hit.at < PROFILE_CACHE_TTL_MS) return hit.profile
  const rows = await dbQuery(
    `SELECT odid, dt, tv, od FROM orders
     WHERE mn1 LIKE '%${digits}%' OR mn2 LIKE '%${digits}%' OR b::text LIKE '%${digits}%'
     ORDER BY dt DESC LIMIT 25`
  )
  let profile = null
  if (rows.length) {
    const last = rows[0]
    const lastDate = last.dt ? new Date(Number(last.dt)).toISOString().slice(0, 10) : null
    const lastDays = last.dt ? Math.floor((Date.now() - Number(last.dt)) / 86400000) : null
    // Booking state only for a RECENT last order (≤14 days) — that's when "kahan tak aaya" matters.
    let awb = null
    if (lastDays !== null && lastDays <= 14) {
      const odidSafe = String(last.odid || '').replace(/[^A-Za-z0-9_~-]/g, '')
      if (odidSafe) {
        try {
          const logs = await dbQuery(
            `SELECT error_booking FROM booking_logs WHERE id LIKE '${odidSafe}%' ORDER BY created_at DESC LIMIT 3`
          )
          awb = (logs.map(l => l.error_booking).find(looksLikeAwb) || '').trim() || null
        } catch { /* ignore */ }
      }
    }
    profile = {
      count: rows.length, countCapped: rows.length === 25,
      lastDate, lastDays,
      lastSummary: summarizeOd(last.od),
      lastValue: last.tv ? Math.round(Number(last.tv)) : null,
      lastAwb: awb, lastTrackUrl: trackUrlFor(awb),
    }
  } else {
    profile = { count: 0 }
  }
  _profileCache.set(digits, { at: Date.now(), profile })
  return profile
}

export function formatBuyerProfileBlock(p) {
  if (!p) return null
  if (p.count === 0) {
    return `👤 BUYER PROFILE (live order system, this buyer's own number): no past website orders found for this number — likely a NEW buyer (or they order under a different number; never assert "aapne kabhi order nahi kiya").`
  }
  const bits = [`${p.count}${p.countCapped ? '+' : ''} past website order${p.count > 1 ? 's' : ''}`]
  if (p.lastDate) {
    let lastBit = `last: ${p.lastDate}${p.lastDays !== null && p.lastDays <= 60 ? ` (${p.lastDays} din pehle)` : ''}`
    if (p.lastSummary) lastBit += ` — ${p.lastSummary}`
    if (p.lastValue) lastBit += `, ₹${p.lastValue.toLocaleString('en-IN')}`
    bits.push(lastBit)
  }
  if (p.lastAwb) bits.push(`newest order BOOKED, tracking: ${p.lastTrackUrl}`)
  else if (p.lastDays !== null && p.lastDays <= 3) bits.push('newest order NOT yet courier-booked')
  return `👤 BUYER PROFILE (live order system, this buyer's own number — TRUSTED background): ${bits.join('; ')}.
HOW TO USE: background context ONLY — makes you sound like you KNOW this buyer (returning buyer ≠ stranger; you may naturally reference their last product when relevant, e.g. "pichhli baar wala 240gsm?"). Do NOT recite this data unprompted, do NOT greet with their order history, NEVER mention a "system/profile/lookup", and complaints/modifications still [DEFER] as usual. Ketu's own thread messages always win.`
}

// Format for prompt injection. Returns null when there is nothing useful to inject.
export function formatOrderLookupBlock(orders) {
  if (!orders) return null
  if (!orders.length) {
    return `📦 ORDER LOOKUP RESULT (live order system, searched by THIS buyer's own WhatsApp number): NO orders found for this number. If they claim they ordered, it may be under a different number — [DEFER] so Ketu checks.`
  }
  const lines = orders.map(o => o.awb
    ? `- Order ${o.shortId} (${o.date || 'date n/a'}): booked, AWB ${o.awb} via ${o.courier} — tracking link: ${o.trackUrl}`
    : `- Order ${o.shortId} (${o.date || 'date n/a'}): NOT yet booked with a courier (no AWB yet)`)
  return `📦 ORDER LOOKUP RESULT (live order system, searched by THIS buyer's own WhatsApp number — TRUSTED FACTS, use them):
${lines.join('\n')}
HOW TO USE: if the buyer is asking where THEIR order is / tracking / "dispatched?" / status — answer from the data above the way Ketu does: one short line + the tracking link, e.g. "Ye raha tracking link sir 👉 [trackUrl]" (use the NEWEST relevant order). If the relevant order shows NOT yet booked, or the buyer is COMPLAINING (late / lost / damaged / "X din ho gaye" / missing pieces), or their question doesn't match these orders → [DEFER] as usual. NEVER invent a status, date, or courier beyond what is shown here.`
}
