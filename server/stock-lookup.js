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
// September arrives as "Sept", not "Sep": CLDR 42 renamed the en-GB/en-IN short
// month, and the supplier app builds the string with toLocaleDateString. Four
// letters is real data. Before this accepted it, every September shipment was
// dropped whole by the `eta === null` guard below and the bot told buyers
// nothing was on the way.
const DT_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 }
function parseDt(dt) {
  const m = /^(\d{1,2})\/([A-Za-z]{3,4})\/(\d{4})$/.exec(String(dt || '').trim())
  if (!m) return null
  const mo = DT_MONTHS[m[2].toLowerCase()]
  if (mo === undefined) return null
  const day = Number(m[1])
  if (day < 1 || day > 31) return null
  return new Date(Number(m[3]), mo, day)
}
function etaDays(dt) {
  const d = parseDt(dt)
  if (!d) return null
  const left = 7 - Math.floor((Date.now() - d.getTime()) / 86400000)
  return Math.max(0, Math.min(7, left))
}

// Coming-soon bundles: supplier orders pinned WITHOUT "Delivered" → in production/transit.
// Returns { "Product|Colour": { eta: minDays, sizes: [...] } } mapped to canonical website names.
//
// SIZES ARE LOAD-BEARING (2026-08-31, buyer 9764372985): a bundle covers specific sizes only, and
// the model was promising a date for sizes that were NOT in it. The supplier row is
// {colour: {size: qty}} — we used to drop the sizes and key on colour alone, so "Kids Black 24 in
// ~6 din" got emitted from a shipment that was Mustard Yellow 22/30/32/34. Keep the size set.
// Supplier design names are typed by hand and several of them carry a trailing space —
// "Honey White ", "SS Black ", "RNYL White ", "RNRL WHITE ", "KIDS RN WHITE ",
// "FINE DS WHITE " — present in every month node we scan. An exact alias lookup missed
// all of them, so the name stayed raw supplier jargon and getStockSnapshot's
// known-products filter then deleted the whole row. Net effect: the WHITE/Black half of
// six real products (Premium Polo, Sweatshirt, Bio Rneck, True Bio Rneck, Kids Rneck,
// Oversize 180gsm) never had an ETA here, every month, while their COLORS siblings did.
// delhi-stock.html normType() and Employee_Khata lookupAlias() both normalise already;
// this matches them. Falls back to the trimmed name so unaliased jargon is at least clean.
function resolveProduct(aliases, aliasNorm, supplierName) {
  return (aliases && aliases[supplierName])
    || aliasNorm[String(supplierName).trim().toLowerCase()]
    || String(supplierName).trim()
}

async function fetchComingSoon() {
  const [pinMap, aliases] = await Promise.all([
    fetchJson(`${INSTOCK_DB}/appData/__pinMap__/pin.json`),
    fetchJson(`${OFFLINE_DB}/config/productAliases.json`),
  ])
  const aliasNorm = {}
  for (const k in (aliases || {})) aliasNorm[String(k).trim().toLowerCase()] = aliases[k]
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
        const product = resolveProduct(aliases, aliasNorm, supplierName)
        const colours = o.od[supplierName]
        if (!colours || typeof colours !== 'object') continue
        for (const colour in colours) {
          const key = `${product}|${colour}`
          const sizes = (colours[colour] && typeof colours[colour] === 'object')
            ? Object.keys(colours[colour]).filter(s => Number(colours[colour][s]) > 0)
            : []
          if (!coming[key]) coming[key] = { eta, sizes: [] }
          if (eta < coming[key].eta) coming[key].eta = eta
          for (const s of sizes) if (!coming[key].sizes.includes(s)) coming[key].sizes.push(s)
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
  lines.push('IN STOCK — orderable on the website RIGHT NOW. Each colour lists ONLY its genuinely-available sizes (out-of-stock sizes already removed) — trust these exactly (product: colours [available sizes]):')
  for (const product in snapshot.inStock) {
    const colours = snapshot.inStock[product]
    if (!colours || typeof colours !== 'object') continue
    const oosForProduct = (snapshot.oos && snapshot.oos[product]) || {}
    // Net-available per colour = catalog sizes MINUS this colour's out-of-stock sizes. The raw
    // table lists every size a colour CAN have; the OOS overlay says which are out right now.
    // Subtract here so the model never reconciles two lists — that mismatch made it wrongly tag
    // one colour's out-size onto another (it told a buyer "Maroon 46 out" because OTHER colours'
    // 46 was out). Group colours that share the same available-size set onto one segment.
    const bySet = {}
    for (const c of Object.keys(colours)) {
      const out = String(oosForProduct[c] || '').split(',').map(s => s.trim()).filter(Boolean)
      const avail = Object.keys(colours[c] || {}).filter(s => !out.includes(s))
      if (!avail.length) continue // fully out for this colour → don't list it under IN STOCK
      const key = avail.join(',')
      if (!bySet[key]) bySet[key] = []
      bySet[key].push(c)
    }
    const setKeys = Object.keys(bySet)
    if (!setKeys.length) continue
    lines.push(`- ${product}: ${setKeys.map(k => `${bySet[k].join(', ')} [${k}]`).join('; ')}`)
  }
  const oosProducts = Object.keys(snapshot.oos || {})
  if (oosProducts.length) {
    lines.push('OUT OF STOCK right now — each entry carries its OWN restock verdict; use ONLY that entry\'s verdict (product: colour [sizes out — restock verdict]):')
    for (const product of oosProducts) {
      const colours = snapshot.oos[product]
      if (!colours || typeof colours !== 'object') continue
      const parts = []
      for (const colour in colours) {
        const oosSizes = String(colours[colour] || '').split(',').map(s => s.trim()).filter(Boolean)
        const allSizes = Object.keys((snapshot.inStock[product] || {})[colour] || {})
        // Restock verdict is resolved HERE, per exact product+colour+size, because the model
        // proved it will not do this matching itself: it read "Kids Rneck — Mustard Yellow: ~6 din"
        // and told a buyer Kids BLACK 24 was arriving in ~6 days, then did the same across colours
        // for True Bio Navy 38 (2026-08-31, buyer 9764372985). Neither had a shipment at all.
        // Same medicine as the Maroon-46 fix above: never leave a join to the model.
        const verdict = (sizes) => {
          const row = (snapshot.coming || {})[`${product}|${colour}`]
          if (!row) return '⛔ NO shipment for this colour — give NO date, NO "din mein aayega"'
          const incoming = row.sizes || []
          const eta = row.eta === 0 ? 'arriving any day' : row.eta === 1 ? '~1 din' : `~${row.eta} din`
          if (!incoming.length) return `↳ shipment coming ${eta} (sizes not listed — do NOT promise any specific size)`
          const covered = sizes.filter(s => incoming.includes(s))
          const missing = sizes.filter(s => !incoming.includes(s))
          if (!covered.length) return `⛔ shipment coming ${eta} but ONLY sizes ${incoming.join(',')} — NOT ${sizes.join(',')}; give NO date for ${sizes.join(',')}`
          return `↳ ${covered.join(',')} arriving ${eta}${missing.length ? `; ⛔ but NOT ${missing.join(',')} — no date for those` : ''}`
        }
        // A colour missing entirely from the in-stock table = fully out.
        if (allSizes.length === 0) { parts.push(`${colour} [ALL sizes out — ${verdict(oosSizes.length ? oosSizes : ['(all)'])}]`); continue }
        // Pre-compute what's LEFT so the model never has to subtract (gpt-4.1 pre-deploy test
        // suggested "Navy 44/42 available" when 44/42 were also in the out-list — spell it out).
        const remaining = allSizes.filter(s => !oosSizes.includes(s))
        parts.push(`${colour} [out: ${oosSizes.join(',')}${remaining.length ? ` — still available: ${remaining.join(',')}` : ' — nothing left, ALL out'} — ${verdict(oosSizes)}]`)
      }
      if (parts.length) lines.push(`- ${product}: ${parts.join(', ')}`)
    }
  }
  const comingKeys = Object.keys(snapshot.coming || {})
  if (comingKeys.length) {
    lines.push('COMING SOON — the ONLY shipments that exist. A product/colour/size NOT listed here has NO known arrival date, no matter what else that product has coming (product — colour: ~days [exact sizes in the shipment]):')
    for (const key of comingKeys.sort()) {
      const row = snapshot.coming[key] || {}
      const eta = row.eta === 0 ? 'arriving any day' : row.eta === 1 ? '~1 din' : `~${row.eta} din`
      lines.push(`- ${key.replace('|', ' — ')}: ${eta}${(row.sizes || []).length ? ` [ONLY sizes ${row.sizes.join(',')}]` : ''}`)
    }
  }
  lines.push('HOW TO ANSWER FROM THIS DATA: each colour in IN STOCK already shows its EXACT orderable sizes — if the asked size appears next to that colour, it IS available; colours are INDEPENDENT, so NEVER say a size is out for one colour just because another colour has it out (e.g. do not claim Maroon 46 is out because Navy/Royal Blue 46 are out). Only call a size out if it is missing from that colour\'s IN STOCK sizes or explicitly in OUT OF STOCK for that exact colour. (1) asked colour/size IS in the IN STOCK list and NOT in OUT OF STOCK → "available hai sir" + order link. (2) It IS in OUT OF STOCK → "abhi out of stock hai sir"; then obey THAT ENTRY\'S OWN restock verdict, which is already resolved for you — "↳ ... arriving ~N din" → you MAY say "~N din mein aa jayega sir"; "⛔" → say NO date at all, not even "jaldi"/"soon"/"thoda time", and point at the Coming Soon tab instead 👉 https://www.bulkplaintshirt.com/delhi-stock.html. ⚠️ NEVER carry an ETA across a colour or a size: a date shown for one colour of a product does NOT apply to another colour of that product, and a shipment\'s sizes do NOT cover sizes missing from it (2026-08-31, buyer 9764372985: the clone read "Kids Rneck — Mustard Yellow ~6 din" and promised Kids BLACK 24 in ~6 days, and read "True Bio Rneck — Black" to promise Navy 38 — neither colour had any shipment; Ketu: "there is nothing in transit for Black 24, how are you saying that?"). An invented arrival date is the single most damaging thing you can say — the buyer waits, nothing comes. If the verdict is ⛔ or you are unsure the row matches the EXACT product+colour+size asked, give no date; suggest 1-2 alternatives — ONLY colours/sizes that are genuinely orderable (use each OUT-OF-STOCK entry\'s "still available:" sizes; NEVER suggest a size/colour listed as out; if the buyer asked for a SPECIFIC size, suggest only colours that have THAT size available). (2b) The buyer asks WHEN something comes back ("kab tak aayegi", "kab aayega", "kab tak available ho jaayegi", "when will it be available / restock") → they want the TIMING, so LEAD with the ETA from that OUT-OF-STOCK entry\'s own verdict ("~N din mein aa jayega sir") — but ONLY if the verdict shows "↳" for the exact colour AND size asked; if it shows "⛔", the honest answer is that you cannot give a date (Coming Soon tab pointer), NOT a borrowed one. Then add what is available meanwhile. Listing only what is in stock IGNORES the question (Ketu 2026-07-27: "acid wash kab tak available ho jaaegi" got a list of available colours; his own answer was the ETA — "Black XL in 2 to 3 days"). If NO COMING SOON row matches that product/colour, do NOT invent a date — say the restock timing shows in the website\'s Coming Soon tab. (3) Product/colour NOT confidently identifiable in this data (naming doubt, variant doubt) → [DEFER] as usual. NEVER state quantities. If Ketu said something different in this thread, HIS word wins.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// PRODUCT-NOT-NAMED RESOLVER (2026-09-05, Ketu). Buyer 8595383520 wrote "White and nevy 38 kab tak
// restock hoga?" — colour + size, no product. The live block was in the prompt, but the model
// would not pick the product itself (Navy 38 is IN STOCK in Bio Rneck and OUT with no shipment
// in True Bio Rneck) and deferred. Ketu: "you should have asked Bio or True Bio, or checked
// yourself and informed." Same medicine as every other stock fix: do the join in code. When the
// text names a colour and/or size but NO product, append a 🔎 section listing, per colour+size,
// every product that carries that colour/size and its exact verdict, and tell the model to ask
// which product in ONE line (or answer directly when only one product fits / the thread already
// names it).
// ---------------------------------------------------------------------------------------------
const COLOUR_ALIASES = [
  ['Navy', /\bn[ae]v[iy]e?\b|\bnavy\s*blue\b|\bnevy\s*blue\b/i],
  ['White', /\bwh?ite\b|\bsafed\b|\bwhyte\b/i],
  ['Off-white', /\boff[\s-]*white\b|\bcream\b/i],
  ['Black', /\bbla?ck\b|\bkala\b|\bkaala\b/i],
  ['Grey', /\bgr[ae]y\b|\bmelange\b/i],
  ['Charcoal', /\bcharco[al]l?\b/i],
  ['Maroon', /\bmaro+[nm]\b/i],
  ['Red', /\bred\b|\blal\b/i],
  ['Royal Blue', /\broyal(\s*blue)?\b/i],
  ['Sky', /\bsky(\s*blue)?\b/i],
  ['Powder Blue', /\bpowder(\s*blue)?\b/i],
  ['Bottle Green', /\bbottle(\s*green)?\b/i],
  ['Army Green', /\barmy(\s*green)?\b|\bolive\b/i],
  ['Flag Green', /\bflag(\s*green)?\b/i],
  ['Sage Green', /\bsage(\s*green)?\b/i],
  ['Mustard Yellow', /\bmustard\b|\byellow\b|\bpeela\b/i],
  ['Orange', /\borange\b/i],
  ['Baby Pink', /\bbaby\s*pink\b|\bpink\b/i],
  ['Rose Pink', /\brose(\s*pink)?\b/i],
  ['Lavender', /\blavender\b|\bpurple\b/i],
  ['Beige', /\bb[ei]{2}ge\b|\bbiege\b/i],
  ['Brown', /\bbrown\b/i],
  ['Bhagwa', /\bbhagwa\b|\bsaffron\b|\bkesari\b/i],
]
// Product words = the buyer DID name a product → the normal block is enough, no resolver.
export const PRODUCT_NAMED_RE = /\b(bio|true\s*bio|non\s*bio|polo|oversize[d]?|over\s*size|drop\s*shoulder|acid|acidwash|hoodie|hoody|sweat\s*shirt|kids?|bachch?o?n?|sublimation|shorts?|zip|zipper|varsity|jacket|boxy|\d{3}\s*gsm|rneck|round\s*neck|premium|cotton\s*polo)\b/i
const SIZE_RE = /\b(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|20|22|24|26|28|30|32|34|36|38|40|42|44|46)\b/gi
// Colour spellings the snapshot itself uses inconsistently (Charcol/Charcoal, Biege/Beige).
const SNAPSHOT_COLOUR_TWINS = { Charcoal: ['Charcol'], Beige: ['Biege'] }

export function detectColoursAndSizes(text) {
  const t = String(text || '')
  const colours = []
  for (const [name, re] of COLOUR_ALIASES) if (re.test(t) && !colours.includes(name)) colours.push(name)
  // "Baby Pink" also matches plain "pink"; "Royal Blue" vs "Sky" are distinct words — fine as-is.
  const sizes = []
  for (const m of t.matchAll(SIZE_RE)) {
    let s = m[1].toUpperCase()
    if (s === '2XL') s = 'XXL'
    if (s === '3XL') s = 'XXXL'
    if (!sizes.includes(s)) sizes.push(s)
  }
  // A bare "s" / "m" / "l" is too common in Hinglish ("s" = "is", "m" = "main") — only trust
  // single-letter alpha sizes when a numeric or two-letter size, or a colour, sits beside them.
  const trusted = sizes.filter(s => !(s.length === 1 && !colours.length && sizes.length === 1))
  return { colours, sizes: trusted, productNamed: PRODUCT_NAMED_RE.test(t) }
}

function productVerdict(snapshot, product, colour, size) {
  const names = [colour, ...(SNAPSHOT_COLOUR_TWINS[colour] || [])]
  const inTable = (snapshot.inStock[product] || {})
  const oosTable = (snapshot.oos && snapshot.oos[product]) || {}
  const c = names.find(n => inTable[n] || oosTable[n])
  if (!c) return null // this product has no such colour at all
  const gridSizes = Object.keys(inTable[c] || {})
  const outSizes = String(oosTable[c] || '').split(',').map(s => s.trim()).filter(Boolean)
  const sizeKnown = !size || gridSizes.includes(size) || outSizes.includes(size)
  if (!sizeKnown) return null // e.g. size 38 on an alpha-sized product → not a candidate
  if (size && !outSizes.includes(size) && gridSizes.includes(size)) return { product, status: '✅ IN STOCK — orderable now' }
  if (!size && gridSizes.some(s => !outSizes.includes(s))) return { product, status: `✅ IN STOCK (sizes ${gridSizes.filter(s => !outSizes.includes(s)).join(',')})` }
  const row = (snapshot.coming || {})[`${product}|${c}`]
  if (!row) return { product, status: '⛔ OUT, NO shipment — no date' }
  const eta = row.eta === 0 ? 'arriving any day' : row.eta === 1 ? '~1 din' : `~${row.eta} din`
  const incoming = row.sizes || []
  if (size && incoming.length && !incoming.includes(size)) return { product, status: `⛔ OUT — shipment ${eta} but NOT size ${size}; no date for ${size}` }
  return { product, status: `⏳ OUT — shipment ${eta}${incoming.length ? ` [sizes ${incoming.join(',')}]` : ' (sizes not listed)'}` }
}

export function resolveUnnamedProduct(snapshot, text) {
  if (!snapshot || !snapshot.inStock) return null
  const { colours, sizes, productNamed } = detectColoursAndSizes(text)
  if (productNamed || !colours.length) return null
  const lines = []
  const products = Object.keys(snapshot.inStock)
  for (const colour of colours) {
    for (const size of (sizes.length ? sizes : [null])) {
      const hits = products.map(p => productVerdict(snapshot, p, colour, size)).filter(Boolean)
      if (!hits.length) continue
      lines.push(`- ${colour}${size ? ' ' + size : ''}: ${hits.map(h => `${h.product} ${h.status}`).join(' · ')}`)
    }
  }
  if (!lines.length) return null
  return [
    '🔎 PRODUCT NOT NAMED — the buyer gave a colour/size but no product, and the answer DIFFERS by product (resolved in code from the block above; trust these exactly):',
    ...lines,
    'HOW TO ANSWER: (a) if the RECENT CONVERSATION already names the product, answer for THAT product only from its verdict — do not ask. (b) Otherwise do NOT [DEFER]: ask which product in ONE short line naming the candidates the way Ketu does ("Bio ya True Bio, sir?"), and fold the verdicts into that same line when they split (e.g. "Bio mein 38 available hai 👉 link, True Bio mein 38 out hai — kaunsa chahiye?"). (c) If only ONE product fits, answer it directly. Never invent a date the verdict does not give.',
  ].join('\n')
}
