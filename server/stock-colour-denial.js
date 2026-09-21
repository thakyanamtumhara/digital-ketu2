import { detectColoursAndSizes, PRODUCT_NAMED_RE, resolveTimedFactProduct } from './stock-lookup.js'

const OTHER_TASK = /\b(?:price|rate|cost|discount|coupon|print\w*|custom\w*|refund\w*|return\w*|received|ordered|dispatch\w*|courier|parcel|invoice|bill|payment|paid|replac\w*|wrong|missing|damag\w*|complaint|photo\w*|image|video|quality|fabric|fit|chart)\b/i
const STOCK_ASK = /\bstock|restock|avail|\b(?:hai|hain|chahiye|chaiye|want|need|kab|kb|milega|aayega|ayega)\b/i
const SIZE = /\b(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL|size|sizes|\d{2})\b/i
const SIZE_ORDER = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL']
const clean = value => String(value || '').replace(/https?:\/\/\S+/gi, '').trim()

export function stockColourDenialGuard({ buyerText, history = [], reply, snapshot, imageUrl, english = false, now = Date.now() }) {
  const response = String(reply || '')
  const buyer = clean(buyerText)
  const age = now - Number(snapshot?.fetchedAt)
  if (imageUrl || !response || /\[(?:DEFER|SKIP)\]/i.test(response) || /\[(?:image|media|photo|video)\]/i.test(buyer)) return null
  if (!snapshot?.inStock || !snapshot.oos || !Number.isFinite(age) || age < 0 || age > 300000) return null
  if (!STOCK_ASK.test(buyer) || OTHER_TASK.test(buyer) || SIZE.test(buyer)) return null
  const recent = [...history].filter(row => {
    const elapsed = now - Date.parse(row.createdAt)
    return elapsed >= 0 && elapsed <= 2 * 3600000
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  if (recent.some(row => row.deferReason === 'manual_reply' || row.isMedia || row.status === 'DEFERRED')) return null
  let product = resolveTimedFactProduct(buyer)
  if (!product && PRODUCT_NAMED_RE.test(buyer)) return null
  if (!product) {
    for (const row of recent) {
      const text = clean(row.buyerMessage)
      if (OTHER_TASK.test(text) || SIZE.test(text)) return null
      product = resolveTimedFactProduct(text)
      if (product) break
      if (PRODUCT_NAMED_RE.test(text)) return null
    }
  }
  if (!product || !snapshot.inStock[product] || !snapshot.oos[product]) return null
  if (PRODUCT_NAMED_RE.test(clean(response)) && resolveTimedFactProduct(clean(response)) !== product) return null
  const requested = detectColoursAndSizes(buyer).colours
  if (!requested.length) return null
  let result = response
  for (const colour of requested) {
    const grid = snapshot.inStock[product][colour]
    const unavailable = snapshot.oos[product][colour]
    if (!grid || typeof grid !== 'object' || Array.isArray(grid) || (unavailable != null && typeof unavailable !== 'string')) continue
    const out = new Set(String(unavailable || '').split(',').map(size => size.trim().toUpperCase()))
    const sizes = Object.keys(grid).filter(size => /^(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL|\d{2})$/.test(size) && !out.has(size))
    if (!sizes.length) continue
    sizes.sort((a, b) => SIZE_ORDER.includes(a) && SIZE_ORDER.includes(b) ? SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b) : a.localeCompare(b, undefined, { numeric: true }))
    const escaped = colour.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const denial = new RegExp(`(^|[.!?;,\\n]\\s*)(${escaped})\\s+(?:(?:is|abhi|currently)\\s+)?(?:out(?:\\s+of\\s+stock)?(?:\\s+hai)?|sold\\s*out|unavailable)(?=\\s*(?:[.!?;,—–]|$|sir\\b))`, 'gi')
    result = result.replace(denial, (_match, boundary, label) => `${boundary}${label} ${sizes.join('/')} ${english ? 'available now' : 'available hai'}`)
  }
  return result === response ? null : result
}
