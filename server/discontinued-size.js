import { detectColoursAndSizes, resolveTimedFactProduct } from './stock-lookup.js'

const OTHER_TASK = /\b(?:price|rates?|cost|discount|coupon|code|print\w*|logo|custom\w*|return\w*|refund\w*|receiv\w*|ordered|dispatch\w*|courier|parcel|invoice|bill|payment|paid|replac\w*|wrong|missing|damag\w*|complaint|photo\w*|image|video|quality|fabric|fit|measurement|chart)\b|\b(?:don't|do not)\b|\b(?:nahi|nhi)\s+chahiye\b|\binstead\b/i
const REQUEST = /\bstock|restock|avail|\bwant\b|\bneed\b|chahiye|chaiye|\b(?:hai|hain|h|kab|kb|milega|aayega|ayega)\b/i
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL']

export function discontinuedSizeRequest(buyerText) {
  const text = String(buyerText || '')
  if (OTHER_TASK.test(text) || !REQUEST.test(text) || resolveTimedFactProduct(text) !== 'Oversize 240gsm') return null
  const { colours, sizes } = detectColoursAndSizes(text)
  if (colours.length !== 1 || ['Black', 'White'].includes(colours[0]) || !sizes.includes('XS')) return null
  if (sizes.some(size => !SIZE_ORDER.includes(size))) return null
  if (/\bXS\s*(?:to|se|[-–])\s*(S|M|L|XL|XXL)\b/i.test(text)) {
    const end = text.match(/\bXS\s*(?:to|se|[-–])\s*(S|M|L|XL|XXL)\b/i)[1].toUpperCase()
    for (const size of SIZE_ORDER.slice(0, SIZE_ORDER.indexOf(end) + 1)) if (!sizes.includes(size)) sizes.push(size)
  }
  return { product: 'Oversize 240gsm', colour: colours[0], sizes: SIZE_ORDER.filter(size => sizes.includes(size)) }
}

export function discontinuedSizeGuard({ buyerText, reply, snapshot, now = Date.now() }) {
  if (!reply || /\[(?:DEFER|SKIP)\]/i.test(reply)) return null
  const request = discontinuedSizeRequest(buyerText)
  if (!request) return null
  const { product, colour, sizes } = request
  const policy = `240gsm ${colour} XS won't be restocked sir; XS is now made only in Black/White.`
  const age = now - Number(snapshot?.fetchedAt)
  if (!snapshot?.inStock || !Number.isFinite(age) || age < 0 || age > 5 * 60000) return `${policy} [DEFER]`
  const aliases = colour === 'Beige' ? ['Beige', 'Biege'] : colour === 'Charcoal' ? ['Charcoal', 'Charcol'] : [colour]
  const key = aliases.find(name => snapshot.inStock[product]?.[name] || snapshot.oos?.[product]?.[name])
  if (!key) return `${policy} [DEFER]`
  const grid = snapshot.inStock[product]?.[key] || {}
  const out = String(snapshot.oos?.[product]?.[key] || '').split(',').map(size => size.trim()).filter(Boolean)
  const available = sizes.filter(size => Object.hasOwn(grid, size) && !out.includes(size))
  const unavailable = sizes.filter(size => size !== 'XS' && out.includes(size))
  const unknown = sizes.filter(size => !Object.hasOwn(grid, size) && !out.includes(size))
  const lines = [policy]
  if (available.length) lines.push(`${available.includes('XS') ? 'Remaining ' : ''}${available.join('/')} ${available.length === 1 ? 'is' : 'are'} available now.`)
  if (unavailable.length) lines.push(`${unavailable.join('/')} ${unavailable.length === 1 ? 'is' : 'are'} out of stock now.`)
  if (unknown.length) lines.push('[DEFER]')
  else lines.push('👉 https://sale91.com/catalog/p/oversize-240gsm')
  return lines.join(' ')
}
