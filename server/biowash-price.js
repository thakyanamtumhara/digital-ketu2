const PRODUCT = /\b(true\s+)?bio(?:[ -]?wash)?(?:\s+(?:rneck|round\s*neck))?\b/gi
const SIMPLE_ASK = /^(?:(?:product|180\s*gsm|regular\s+fit|t-?shirts?|what|is|of|hi|hello|sir|bhai|please|pls|plz|share|send|tell|me|the|your|ka|ki|ke|k|kya|hai|hain|h|rate|rates|price|prices|list)\s*)+$/i
const SELECTED = /\b(?:xxs|xs|s|m|l|xl|xxl|xxxl|36|38|40|42|44|46|black|white|navy|grey|gray|maroon|charcoal|red|brown|pink|samples?)\b|\b\d+\s*(?:pcs?|pieces?|t-?shirts?)\b/i

export function biowashRateSummaryGuard({ products = [], buyerText, history = [], reply, english = false }) {
  const text = String(buyerText || '').trim().replace(/[?!.,]+$/g, '').trim()
  const output = String(reply || '')
  const named = [...text.matchAll(PRODUCT)]
  if (text.length > 110 || named.length !== 1 || !SIMPLE_ASK.test(text.replace(PRODUCT, 'product'))) return null
  if (!/\b(?:price|prices|rate|rates)\b/i.test(text)) return null
  const quoted = [...output.replace(/https?:\/\/\S+/gi, '').matchAll(PRODUCT)]
  if (!quoted.length || quoted.length > 2 || quoted.some(item => !!item[1] !== !!named[0][1]) || output.length > 300) return null
  const priceCount = (output.match(/(?:₹\s*|\brs\.?\s*)\d+(?:\.\d+)?/gi) || []).length
  const withSample = priceCount === 2 && /\bbulk\b/i.test(output) && /\bsample\b/i.test(output)
  if (priceCount !== 1 && !withSample) return null
  if (history.some(row => SELECTED.test(String(row.deferReason === 'manual_reply' ? row.aiReply || '' : row.buyerMessage || '').replace(/https?:\/\/\S+/gi, '')))) return null
  const slug = named[0][1] ? 'true-biowash-round-neck' : 'biowash-round-neck'
  const links = output.match(/https?:\/\/\S+/gi) || []
  if (links.some(url => !new RegExp(`^https://(?:www\\.)?(?:sale91\\.com|bulkplaintshirt\\.com)/catalog(?:/p/${slug})?[).,!]*$`, 'i').test(url))) return null
  const summary = output.replace(/https?:\/\/\S+/gi, '').replace(PRODUCT, 'product').replace(/(?:₹\s*|\brs\.?\s*)\d+(?:\.\d+)?/gi, '').replace(/\b180\s*gsm\b/gi, '').replace(/\b10\s*\+/g, '')
  if (/\d|\p{L}/u.test(summary.replace(/[a-z]/gi, ''))) return null
  const words = summary.replace(/[^a-z]+/gi, ' ').trim().split(/\s+/)
  if (words.some(word => !(withSample && /^sample$/i.test(word)) && !/^(?:product|bulk|pcs?|pieces?|per|each|is|are|at|for|in|the|price|prices|rate|rates|hai|hain|h|sir|bhai|pe|mein|ka|ke|ki)$/i.test(word))) return null
  const matches = products.filter(p => p.slug === slug)
  if (matches.length !== 1) return null
  const product = matches[0], range = product.bulkRange
  if (product.gsm !== 180 || !Array.isArray(range) || range.length !== 2 || range.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0) || range[0] > range[1]) return null
  const sample = product.sampleRange
  if (withSample && (!Array.isArray(sample) || sample.length !== 2 || sample.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0) || sample[0] > sample[1])) return null
  const price = `₹${range[0]}${range[0] === range[1] ? '' : `–₹${range[1]}`}`
  const samplePrice = withSample ? `; ₹${sample[0]}${sample[0] === sample[1] ? '' : `–₹${sample[1]}`} sample` : ''
  const address = !english && /\bbhai\b/i.test(output) ? 'bhai' : 'sir'
  return `${named[0][1] ? 'True Bio' : 'Bio'} Rneck 180gsm ${price} bulk (10+ total pcs, ${english ? 'by colour/size' : 'colour/size ke hisaab se'})${samplePrice} ${address} 👉 https://sale91.com/catalog/p/${slug}`
}
