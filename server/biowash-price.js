const PRODUCT = /\b(true\s+)?bio(?:[ -]?wash)?(?:\s+(?:rneck|round\s*neck))?\b/gi
const SIMPLE_ASK = /^(?:(?:product|180\s*gsm|regular\s+fit|t-?shirts?|what|is|of|hi|hello|sir|bhai|please|pls|plz|share|send|tell|me|the|your|ka|ki|ke|k|kya|hai|hain|h|rate|rates|price|prices|list)\s*)+$/i
const SELECTED = /\b(?:xxs|xs|s|m|l|xl|xxl|xxxl|36|38|40|42|44|46|black|white|navy|grey|gray|maroon|charcoal|red|brown|pink|samples?)\b|\b\d+\s*(?:pcs?|pieces?|t-?shirts?)\b/i

export function mixedFitRegularPriceGuard({ products = [], buyerText, history = [], reply, imageUrl = null }) {
  const text = String(buyerText || '')
  const output = String(reply || '')
  const excluded = /\d|\[[^\]]+\]|https?:\/\/|\b(?:samples?|size|colou?rs?|coupon|refund|exchange|return|complaint|payment|paid|dispatch|delivery|stock|restock|cotton|fabric|polo|hoodie|kids?|acid|bio(?:wash)?)\b/i
  if (imageUrl || text.length > 250 || !/\b(?:rate|price)s?\b/i.test(text) || !/\bgsm\b/i.test(text) || excluded.test(text) || SELECTED.test(text)) return null
  if (history.slice(-6).some(row => row.deferReason === 'manual_reply' || row.isMedia || excluded.test(String(row.buyerMessage || '')) || SELECTED.test(String(row.buyerMessage || '')))) return null
  if (output.length > 700 || /\[(?:DEFER|SKIP)\]|\bsample\b/i.test(output) || !/\boversize\s*:/i.test(output) || !/\b10\s*\+\s*(?:total\s*)?(?:pcs?|pieces?)\b/i.test(output)) return null
  const clause = /\bRegular\s+fit\s*(?:\(\s*(\d{3})\s*gsm\s*\)|(\d{3})\s*gsm)\s*:\s*(Non[ -]?Bio\s*₹\s*\d+(?:\.\d+)?\s*,\s*Bio\s*₹\s*\d+(?:\.\d+)?\s*,\s*True\s+Bio\s*₹\s*\d+(?:\.\d+)?)(?=\s*[.\n])/gi
  const matches = [...output.matchAll(clause)]
  if (matches.length !== 1) return null
  const match = matches[0]
  const slugs = ['non-bio-round-neck', 'biowash-round-neck', 'true-biowash-round-neck']
  const options = slugs.map(slug => products.filter(p => p.slug === slug))
  if (options.some(items => items.length !== 1)) return null
  const selected = options.map(items => items[0])
  if (selected.some(p => p.gsm !== Number(match[1] || match[2]) || !Array.isArray(p.bulkRange) || p.bulkRange.length !== 2 || p.bulkRange.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0) || p.bulkRange[0] > p.bulkRange[1])) return null
  if (selected.some(p => (p.colors || []).some(colour => new RegExp(`\\b${String(colour).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test([text, ...history.slice(-6).map(row => row.buyerMessage || '')].join('\n'))))) return null
  let index = 0
  const corrected = match[0].replace(/₹\s*\d+(?:\.\d+)?/g, () => {
    const range = selected[index++].bulkRange
    return `₹${range[0]}${range[0] === range[1] ? '' : `–₹${range[1]}`}`
  })
  if (corrected === match[0]) return null
  return output.slice(0, match.index) + corrected + output.slice(match.index + match[0].length)
}

export function regularFitRateSummaryGuard({ products = [], buyerText, history = [], reply, imageUrl = null, english = false }) {
  const text = String(buyerText || '').trim().replace(/[?!.,]+$/g, '').trim()
  const output = String(reply || '')
  if (imageUrl || text.length > 110 || !/\b180\s*gsm\b/i.test(text) || !/\bregular\s+fit\b/i.test(text) || !/\b(?:prices?|rates?)\b/i.test(text) || !SIMPLE_ASK.test(text)) return null
  const slugs = ['true-biowash-round-neck', 'biowash-round-neck']
  const selected = slugs.map(slug => products.filter(p => p.slug === slug))
  if (selected.some(matches => matches.length !== 1) || products.filter(p => p.gsm === 180 && p.fit === 'regular').length !== 2) return null
  const options = selected.map(matches => matches[0])
  if (options.some(p => p.gsm !== 180 || p.fit !== 'regular' || !Array.isArray(p.bulkRange) || p.bulkRange.length !== 2 || p.bulkRange.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0) || p.bulkRange[0] > p.bulkRange[1])) return null
  if (history.some(row => {
    const prior = String(row.deferReason === 'manual_reply' ? row.aiReply || '' : row.buyerMessage || '').replace(/https?:\/\/\S+/gi, '')
    return SELECTED.test(prior) || /\bbio(?:wash)?\b|\b(?:polo|kids?|oversiz(?:e|ed)|hoodie|sublimation|stock|restock|refund|complaint)\b|\[[^\]]+\]/i.test(prior)
      || options.some(p => (p.colors || []).some(colour => new RegExp(`\\b${String(colour).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(prior)))
  })) return null
  const summaryProduct = /\b(non[ -]*bio|true\s+bio|bio)(?:[ -]?wash)?(?:\s+(?:rneck|round\s*neck))?\b/gi
  const quotes = [...output.replace(/https?:\/\/\S+/gi, '').matchAll(summaryProduct)].map(m => m[1].toLowerCase().replace(/[ -]/g, ''))
  if (output.length > 300 || ![2, 3].includes(quotes.length) || new Set(quotes).size !== quotes.length || !quotes.includes('truebio') || !quotes.includes('bio')) return null
  if ((output.match(/(?:₹\s*|\brs\.?\s*)\d+(?:\.\d+)?/gi) || []).length !== quotes.length) return null
  const links = output.match(/https?:\/\/\S+/gi) || []
  if (links.some(url => !/^https:\/\/(?:www\.)?(?:sale91\.com|bulkplaintshirt\.com)\/catalog(?:\/p\/(?:true-)?biowash-round-neck)?[).,!]*$/i.test(url))) return null
  const summary = output.replace(/https?:\/\/\S+/gi, '').replace(summaryProduct, 'product').replace(/(?:₹\s*|\brs\.?\s*)\d+(?:\.\d+)?/gi, '').replace(/\b180\s*gsm\b/gi, '').replace(/\b10\s*\+/g, '')
  if (/\d|\p{L}/u.test(summary.replace(/[a-z]/gi, ''))) return null
  const words = summary.replace(/[^a-z]+/gi, ' ').trim().split(/\s+/)
  if (words.some(word => !/^(?:product|regular|fit|bulk|pcs?|pieces?|per|each|and|or|is|are|at|for|in|the|price|prices|rate|rates|hai|hain|h|sir|bhai|pe|mein|ka|ke|ki|aur)$/i.test(word))) return null
  const names = ['True Bio', 'Bio']
  const prices = options.map((p, i) => `${names[i]} ₹${p.bulkRange[0]}${p.bulkRange[0] === p.bulkRange[1] ? '' : `–₹${p.bulkRange[1]}`}`).join('; ')
  return `180gsm regular fit: ${prices} bulk (10+ total pcs, ${english ? 'by colour/size' : 'colour/size ke hisaab se'}) sir 👉 https://sale91.com/catalog`
}

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
