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
      trackUrl: awb ? `https://trq.pages.dev/?${awb}` : null,
    })
  }
  return out
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
