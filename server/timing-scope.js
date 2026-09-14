import { resolveTimedFactProduct, detectColoursAndSizes, PRODUCT_NAMED_RE } from './stock-lookup.js'
import { parseTimedFact, formatTimedFactsBlock } from './timed-facts.js'

const COLOURS = /\b(off[\s-]*white|royal\s+blue|powder\s+blue|sky\s+blue|bottle\s+green|army\s+green|flag\s+green|sage\s+green|mustard\s+yellow|baby\s+pink|rose\s+pink|black|white|navy|red|maroon|grey|gray|charcoal|charcol|beige|biege|brown|orange|lavender|pink|yellow|mustard|green|blue|sky|bhagwa)\b/gi
const TIMING = /\b(?:restock|refill|stock|available|availability|coming|launch|when|kab|kb|aayega|ayega|aayegi|aaegi|aayenge|nahi|nhi|out|estimated|how\s+long)\b|कब|स्टॉक|नहीं|आएग/i
const women = /\b(?:women(?:'?s)?|womens|ladies|female)\b|महिला|लेडी[जज़]|वूम[ेै]न/i
const normalizeColour = text => text.toLowerCase().replace(/[-\s]+/g, ' ').replace(/^offwhite$/, 'off white').replace(/^gray$/, 'grey').replace(/^charcol$/, 'charcoal').replace(/^biege$/, 'beige').replace(/^sky blue$/, 'sky')

function dimensions(text) {
  const clean = String(text || '').replace(/https?:\/\/\S+/gi, ' ').replace(/\[[^\]]*\]/g, ' ')
  const named = PRODUCT_NAMED_RE.test(clean) || women.test(clean)
  const product = women.test(clean) && !PRODUCT_NAMED_RE.test(clean) ? 'Women range' : resolveTimedFactProduct(clean)
  return { named, product, colours: [...new Set([...clean.matchAll(COLOURS)].map(m => normalizeColour(m[0])))], sizes: detectColoursAndSizes(clean).sizes }
}

export function resolveTimingRequest(buyerText, history = [], now = Date.now()) {
  const current = dimensions(buyerText)
  if (!TIMING.test(buyerText || '')) return null
  if (current.named) return current
  for (const row of [...history].reverse().slice(0, 12)) {
    if (row.deferReason === 'manual_reply' || !row.buyerMessage) continue
    const at = Date.parse(row.createdAt)
    if (!Number.isFinite(at) || at > now || now - at > 72 * 3600000) continue
    const prior = dimensions(row.buyerMessage)
    if (!current.colours.length) current.colours = prior.colours
    if (!current.sizes.length) current.sizes = prior.sizes
    if (prior.named) return { ...current, named: true, product: prior.product }
  }
  return current
}

export function scopedTimingBlock(facts, now = Date.now(), buyerText = '', history = []) {
  const request = resolveTimingRequest(buyerText, history, now)
  if (!request) return null
  const selected = (facts || []).filter(row => {
    const parsed = parseTimedFact(typeof row === 'string' ? row : row.content)
    if (!parsed || !request.product) return false
    const source = dimensions(parsed.question)
    if (source.product !== request.product) return false
    if (request.colours.length ? !request.colours.every(c => source.colours.includes(c)) : source.colours.length) return false
    if (source.sizes.length && (!request.sizes.length || !request.sizes.every(s => source.sizes.includes(s)))) return false
    if (request.sizes.length && !source.sizes.length && !/\ball\s+sizes\b|sabhi\s+sizes?/i.test(parsed.question)) return false
    if (request.product === 'Oversize 240gsm' && request.sizes.includes('XS') && request.colours.some(c => !['black', 'white'].includes(c))) return false
    return true
  })
  const block = formatTimedFactsBlock(selected, now, buyerText)
  if (block) return block
  if (!request.named && !request.colours.length && !request.sizes.length) return null
  return 'TIMING SCOPE: No saved timing answer covers the full requested product, colour and size scope. Do not reuse dates from other variants or earlier assistant replies. An exact matching LIVE STOCK shipment may still supply a date; otherwise give no date and follow the existing clarification or handoff policy.'
}
