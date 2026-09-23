const SIMPLE_ASK = /^(?:(?:hi|hello|sir|please|pls|plz|share|send|tell|me|the|your|ka|ki|ke|kya|hai|hain|rate|rates|price|prices|list|hoodie|hoodies|320\s*gsm)\s*)+$/i
const SELECTED = /\b(?:size|sizes|xxs|xs|s|m|l|xl|xxl|xxxl|black|white|navy|grey|gray|maroon|charcoal|red|green|zip|zipper|430|samples?)\b|\b\d+\s*(?:pcs?|pieces?|shirts?|hoodies?)\b/i

function hoodieBulkRange(products) {
  const matches = products.filter(product => product.slug === 'hoodie-320gsm')
  if (matches.length !== 1) return null
  const product = matches[0], range = product.bulkRange
  if (product.gsm !== 320 || !Array.isArray(range) || range.length !== 2 || range.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0) || range[0] > range[1]) return null
  return `₹${range[0]}${range[0] === range[1] ? '' : `–₹${range[1]}`}`
}

function simpleHoodieRateSummary({ products = [], buyerText, history = [], reply, english = false }) {
  const text = String(buyerText || '').trim().replace(/[?!.,]+$/g, '').trim()
  const output = String(reply || '')
  if (text.length > 100 || !/\bhoodies?\b/i.test(text) || !SIMPLE_ASK.test(text)) return null
  if (!/\bhoodie\b/i.test(output) || !/\b320\s*gsm\b/i.test(output) || output.length > 300) return null
  if (!/(?:₹\s*|\brs\.?\s*)\d/i.test(output)) return null
  if (/\[(?:DEFER|SKIP)\]|\b(?:sample|stock|available|delivery|refund|discount|code|fabric|cotton|polyester|printing|complaint|zip|zipper|size|sizes|xxs|xs|s|m|l|xl|xxl|xxxl)\b/i.test(output)) return null
  if (/\b(?:from|starts?|range)\b|\bse\s*(?:shuru|start)|₹\s*\d+\s*[–-]\s*₹?\s*\d+/i.test(output)) return null
  if (history.some(row => SELECTED.test(String(row.deferReason === 'manual_reply' ? row.aiReply || '' : row.buyerMessage || '').replace(/https?:\/\/\S+/gi, '')))) return null
  const links = output.match(/https?:\/\/\S+/gi) || []
  if (links.some(url => !/^https:\/\/(?:www\.)?(?:sale91\.com|bulkplaintshirt\.com)\/catalog(?:\/p\/hoodie-320gsm)?[).,!]*$/i.test(url))) return null
  const summary = output.replace(/https?:\/\/\S+/gi, '').replace(/(?:₹\s*|\brs\.?\s*)\d+(?:\.\d+)?/gi, '').replace(/\b320\s*gsm\b/gi, '').replace(/\b10\s*\+/g, '')
  if (/\d/.test(summary)) return null
  if (/\p{L}/u.test(summary.replace(/[a-z]/gi, ''))) return null
  const words = summary.replace(/[^a-z]+/gi, ' ').trim().split(/\s+/)
  if (words.some(word => !/^(?:hoodie|hoodies|black|white|navy|army|green|off|maroon|grey|gray|red|other|others|rest|colour|colours|color|colors|baaki|baki|bulk|pcs?|pieces?|per|each|and|or|is|are|at|for|in|the|price|prices|rate|rates|hai|hain|sir|pe|mein|ka|ke|ki|aur)$/i.test(word))) return null
  const price = hoodieBulkRange(products)
  if (!price) return null
  return `Hoodie 320gsm ${price} bulk (10+ total pcs, ${english ? 'by colour/size' : 'colour/size ke hisaab se'}) sir 👉 https://sale91.com/catalog/p/hoodie-320gsm`
}

export function hoodieRateSummaryGuard(params) {
  const simple = simpleHoodieRateSummary(params)
  if (simple) return simple
  const { products = [], buyerText, history = [], reply, english = false } = params
  const text = String(buyerText || ''), output = String(reply || '')
  if (!/\bhoodies?\b/i.test(text) || !/\b(?:price|prices|rate|rates)\b/i.test(text)) return null
  if (SELECTED.test(text) || /\[(?:image|video|audio)\]/i.test(text)) return null
  if (/\b(?:oversized?|drop[\s-]?shoulder|acid[\s-]?wash)\b/i.test(text)) return null
  if ([...text.matchAll(/\b(\d+)\s*gsm\b/gi)].some(match => Number(match[1]) !== 320)) return null
  if (!/\n[ \t]*\[DEFER\][ \t]*$/.test(output) || /\[SKIP\]/.test(output)) return null
  if (/\b(?:sizes?|xxs|xs|s|m|l|xl|xxl|xxxl|samples?)\b/i.test(output.replace(/https?:\/\/\S+/gi, ''))) return null
  if (history.some(row => SELECTED.test(String(row.deferReason === 'manual_reply' ? row.aiReply || '' : row.buyerMessage || '').replace(/https?:\/\/\S+/gi, '')))) return null
  const scalarPair = /\bhoodie\s*320\s*gsm\b(?:\s*\((?:loopknit|terry(?:\s+cotton)?)\))?\s*(Black\s*(?:₹\s*|Rs\.?\s*)\d+(?:\.\d+)?\s*,\s*(?:baaki|baki|other|rest)\s+colou?rs?\s*(?:₹\s*|Rs\.?\s*)\d+(?:\.\d+)?)(?=\s*(?:sir\s*)?[.!?\n])/gi
  const quotes = [...output.matchAll(scalarPair)]
  if (quotes.length !== 1) return null
  const match = quotes[0]
  const beforeQuote = output.slice(0, match.index).split(/[.!?\n]/).at(-1)
  if (/\b(?:size|sizes|xxs|xs|s|m|l|xl|xxl|xxxl|sample|samples|from|starts?|range)\b/i.test(beforeQuote)) return null
  const price = hoodieBulkRange(products)
  if (!price) return null
  const start = match.index + match[0].indexOf(match[1])
  const replacement = `${price} bulk (10+ total pcs, ${english ? 'by colour/size' : 'colour/size ke hisaab se'})`
  return output.slice(0, start) + replacement + output.slice(start + match[1].length)
}
