const SIMPLE_ASK = /^(?:(?:hi|hello|sir|please|pls|plz|share|send|tell|me|the|your|ka|ki|ke|kya|hai|hain|rate|rates|price|prices|list|hoodie|hoodies|320\s*gsm)\s*)+$/i
const SELECTED = /\b(?:size|sizes|xxs|xs|s|m|l|xl|xxl|xxxl|black|white|navy|grey|gray|maroon|charcoal|red|green|zip|zipper|430|samples?)\b|\b\d+\s*(?:pcs?|pieces?|shirts?|hoodies?)\b/i

export function hoodieRateSummaryGuard({ products = [], buyerText, history = [], reply, english = false }) {
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
  const matches = products.filter(p => p.slug === 'hoodie-320gsm')
  if (matches.length !== 1) return null
  const product = matches[0], range = product.bulkRange
  if (product.gsm !== 320 || !Array.isArray(range) || range.length !== 2 || range.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0) || range[0] > range[1]) return null
  const price = `₹${range[0]}${range[0] === range[1] ? '' : `–₹${range[1]}`}`
  return `Hoodie 320gsm ${price} bulk (10+ total pcs, ${english ? 'by colour/size' : 'colour/size ke hisaab se'}) sir 👉 https://sale91.com/catalog/p/hoodie-320gsm`
}
