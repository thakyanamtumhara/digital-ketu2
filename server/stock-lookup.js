// LIVE STOCK FEED (2026-07-21, Ketu-approved: "For live stock feed... pc.js... that file always
// gets updated if something goes out of stock or comes back in stock"). Closes the #1 defer
// bucket: real-time "is X in stock?" questions, which until now ALWAYS deferred to Ketu.
//
// Two read-only public sources, both the same ones the buyer-facing delhi-stock.html page uses:
//
// 1. IN / OUT OF STOCK — https://www.bulkplaintshirt.com/pc.js (the website's own price table).
//    tbl[0] = product → colour → size → price: presence means the buyer can ORDER it on the site
//    RIGHT NOW, so "available hai sir" is correct by construction. tbl[10] = the explicit
//    out-of-stock map: product → colour → comma-list of OOS sizes (verified live: Boxy Fit shows
//    every size out, matching reality). Cloudflare caches pc.js for 4h (memory: CC1 CF TTL), so we
//    cache-bust with a 5-minute query bucket — each bucket is a fresh cache key that hits S3.
//
// 2. COMING SOON ETA — supplier bundles ordered into the Delhi godam but not yet delivered.
//    Same data the public page's "Coming Soon" tab shows: in-stock-6d6cb appData/s<FY><MM>/od
//    (supplier app orders), pin map appData/__pinMap__/pin ("ods<id>" → status; contains
//    "Delivered" = landed), supplier→website names via new-main-offline-app config/productAliases.
//    ETA = clamp(0..7, 7 − daysSince(order dt)) — identical to the page's etaDaysLeft(). We only
//    consult this when pc.js already says OOS, so the two sources can never contradict. We do NOT
//    replicate the page's financially-critical avail math (stockCache base + sold merges) — pc.js
//    answers in-stock; this only answers "kab aayega".
//
// CONSERVATIVE BY DESIGN: an order missing from the pin map is treated as delivered (NOT coming) —
// fewer false "aa raha hai" promises. Any fetch/parse failure → null → the caller injects nothing
// and the old always-defer behaviour is untouched (fail-closed).

const PC_JS_URL = 'https://www.bulkplaintshirt.com/pc.js'
const INSTOCK_DB = 'https://in-stock-6d6cb-default-rtdb.asia-southeast1.firebasedatabase.app'
const OFFLINE_DB = 'https://new-main-offline-app-default-rtdb.asia-southeast1.firebasedatabase.app'

const CACHE_TTL_MS = 5 * 60 * 1000
let _cache = { at: 0, snapshot: null }

async function fetchJson(url, timeoutMs = 12000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${res.status} on ${url.slice(0, 80)}`)
  return res.json()
}

// pc.js is "let tbl=[...JSON...]" — everything after the first "=" is valid JSON (keys quoted).
async function fetchPcTable() {
  const bucket = Math.floor(Date.now() / CACHE_TTL_MS) // 5-min bucket = Cloudflare cache-bust
  const res = await fetch(`${PC_JS_URL}?dk2=${bucket}`, { signal: AbortSignal.timeout(12000) })
  if (!res.ok) throw new Error(`pc.js ${res.status}`)
  const src = await res.text()
  const eq = src.indexOf('=')
  if (eq === -1) throw new Error('pc.js: no assignment found')
  const tbl = JSON.parse(src.slice(eq + 1).replace(/;\s*$/, ''))
  if (!Array.isArray(tbl) || !tbl[0] || typeof tbl[0] !== 'object') throw new Error('pc.js: unexpected shape')
  return { inStock: tbl[0], oos: (tbl[10] && typeof tbl[10] === 'object') ? tbl[10] : {} }
}

// Current fiscal-month key, same derivation as delhi-stock.html getCurMonth()+getMonthKeyVariants:
// July 2026 → appData/s262707. Also return the previous month key for early-month rollover lag.
function supplierMonthKeys() {
  const now = new Date()
  const keys = []
  for (const d of [now, new Date(now.getFullYear(), now.getMonth() - 1, 15)]) {
    const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
    const key = `s${String(fy).slice(2)}${String(fy + 1).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

// "02/Jul/2026" → Date (page's parseDtString equivalent, month-name format only)
const DT_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
function parseDt(dt) {
  const m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})$/.exec(String(dt || '').trim())
  if (!m || !(m[2] in DT_MONTHS)) return null
  return new Date(Number(m[3]), DT_MONTHS[m[2]], Number(m[1]))
}
function etaDays(dt) {
  const d = parseDt(dt)
  if (!d) return null
  const left = 7 - Math.floor((Date.now() - d.getTime()) / 86400000)
  return Math.max(0, Math.min(7, left))
}

// Coming-soon bundles: supplier orders pinned WITHOUT "Delivered" → in production/transit.
// Returns { "Product|Colour": minEtaDays } mapped to canonical website product names.
async function fetchComingSoon() {
  const [pinMap, aliases] = await Promise.all([
    fetchJson(`${INSTOCK_DB}/appData/__pinMap__/pin.json`),
    fetchJson(`${OFFLINE_DB}/config/productAliases.json`),
  ])
  if (!pinMap || typeof pinMap !== 'object') return {}
  const coming = {}
  for (const mk of supplierMonthKeys()) {
    let data
    try { data = await fetchJson(`${INSTOCK_DB}/appData/${mk}.json`) } catch { continue }
    let arr = data && (data.od || data)
    if (arr && !Array.isArray(arr) && typeof arr === 'object') arr = Object.values(arr)
    if (!Array.isArray(arr)) continue
    for (const o of arr) {
      if (!o || !o.od || typeof o.od !== 'object') continue
      // Pin keys observed live as "ods<id>" (e.g. ods2627070000185); check legacy "od<id>" too.
      const status = pinMap[`ods${o.id}`] ?? pinMap[`od${o.id}`]
      // Only PINNED orders whose status lacks "Delivered" are still incoming. Unpinned or
      // Delivered → landed (conservative: we'd rather miss an ETA than promise a false one).
      if (typeof status !== 'string' || status.includes('Delivered')) continue
      const eta = etaDays(o.dt)
      if (eta === null) continue
      for (const supplierName in o.od) {
        const product = (aliases && aliases[supplierName]) || supplierName
        const colours = o.od[supplierName]
        if (!colours || typeof colours !== 'object') continue
        for (const colour in colours) {
          const key = `${product}|${colour}`
          if (!(key in coming) || eta < coming[key]) coming[key] = eta
        }
      }
    }
  }
  return coming
}

export async function getStockSnapshot() {
  if (_cache.snapshot && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.snapshot
  const pc = await fetchPcTable() // throws → caller's fail-closed path
  let coming = {}
  try {
    coming = await fetchComingSoon() // best-effort: in-stock answers still work without ETAs
  } catch (err) {
    console.warn('[StockLookup] coming-soon fetch failed (in/out-of-stock still live):', err.message)
  }
  // Drop coming-soon rows whose product name didn't resolve to a website product (unmapped
  // supplier jargon like "RNYL White" would only confuse the model — no alias, no row).
  const known = new Set([...Object.keys(pc.inStock), ...Object.keys(pc.oos)])
  for (const key of Object.keys(coming)) {
    if (!known.has(key.split('|')[0])) delete coming[key]
  }
  const snapshot = { ...pc, coming, fetchedAt: Date.now() }
  _cache = { at: Date.now(), snapshot }
  return snapshot
}

function istTime(ts) {
  return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true })
}

// Compact prompt block. Full catalog every time (no keyword filtering — a filter miss would look
// like "not in data" and cause a wrong answer; ~700 tokens only on stock-intent turns is cheap).
export function formatStockBlock(snapshot) {
  if (!snapshot || !snapshot.inStock) return null
  const lines = []
  lines.push(`📦 LIVE STOCK DATA (source: website's own live price table + incoming-production feed, as of ${istTime(snapshot.fetchedAt)} IST — TRUSTED, answer stock questions FROM this):`)
  lines.push('IN STOCK — orderable on the website RIGHT NOW (product: colours [sizes]):')
  for (const product in snapshot.inStock) {
    const colours = snapshot.inStock[product]
    if (!colours || typeof colours !== 'object') continue
    const colourNames = Object.keys(colours)
    if (colourNames.length === 0) continue
    // If every colour has the same size set, print it once; else per-colour.
    const sizeSets = colourNames.map(c => Object.keys(colours[c] || {}).join(','))
    const uniform = sizeSets.every(s => s === sizeSets[0])
    if (uniform) {
      lines.push(`- ${product}: ${colourNames.join(', ')} [${sizeSets[0]}]`)
    } else {
      lines.push(`- ${product}: ${colourNames.map((c, i) => `${c} [${sizeSets[i]}]`).join(', ')}`)
    }
  }
  const oosProducts = Object.keys(snapshot.oos || {})
  if (oosProducts.length) {
    lines.push('OUT OF STOCK right now (product: colour [sizes out]):')
    for (const product of oosProducts) {
      const colours = snapshot.oos[product]
      if (!colours || typeof colours !== 'object') continue
      const parts = []
      for (const colour in colours) {
        const oosSizes = String(colours[colour] || '').split(',').map(s => s.trim()).filter(Boolean)
        const allSizes = Object.keys((snapshot.inStock[product] || {})[colour] || {})
        // A colour missing entirely from the in-stock table = fully out.
        if (allSizes.length === 0) { parts.push(`${colour} [ALL sizes out]`); continue }
        // Pre-compute what's LEFT so the model never has to subtract (gpt-4.1 pre-deploy test
        // suggested "Navy 44/42 available" when 44/42 were also in the out-list — spell it out).
        const remaining = allSizes.filter(s => !oosSizes.includes(s))
        parts.push(`${colour} [out: ${oosSizes.join(',')}${remaining.length ? ` — still available: ${remaining.join(',')}` : ' — nothing left, ALL out'}]`)
      }
      if (parts.length) lines.push(`- ${product}: ${parts.join(', ')}`)
    }
  }
  const comingKeys = Object.keys(snapshot.coming || {})
  if (comingKeys.length) {
    lines.push('COMING SOON — already ordered into the Delhi godam, landing shortly (product|colour: ~days):')
    for (const key of comingKeys.sort()) {
      const eta = snapshot.coming[key]
      lines.push(`- ${key.replace('|', ' — ')}: ${eta === 0 ? 'arriving any day' : eta === 1 ? '~1 din' : `~${eta} din`}`)
    }
  }
  lines.push('HOW TO ANSWER FROM THIS DATA: (1) asked colour/size IS in the IN STOCK list and NOT in OUT OF STOCK → "available hai sir" + order link. (2) It IS in OUT OF STOCK → "abhi out of stock hai sir"; if a matching COMING SOON row exists add "~N din mein aa jayega"; suggest 1-2 alternatives — ONLY colours/sizes that are genuinely orderable (use each OUT-OF-STOCK entry\'s "still available:" sizes; NEVER suggest a size/colour listed as out; if the buyer asked for a SPECIFIC size, suggest only colours that have THAT size available). (3) Product/colour NOT confidently identifiable in this data (naming doubt, variant doubt) → [DEFER] as usual. NEVER state quantities. If Ketu said something different in this thread, HIS word wins.')
  return lines.join('\n')
}
