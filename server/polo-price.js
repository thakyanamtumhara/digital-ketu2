const SIMPLE_POLO_ASK = /^(?:(?:i|we)\s+(?:need|want)\s+)?(?:(?:hi|hello|sir|please|pls|plz|share|send|tell|me|the|your|both|details?|of|t[- ]?shirts?|ka|ki|ke|kya|hai|hain|rate|rates|price|prices|list|polo|polos)\s*)+$/i
const SELECTED_VARIANT = /\b(?:size|sizes|xxs|xs|s|m|l|xl|xxl|xxxl|20|22|24|26|28|30|32|34|36|38|40|42|44|46|black|white|navy|grey|gray|maroon|charcoal|red|kids?|child(?:ren)?)\b/i
const SAMPLE_ORDER = /\bsamples?\b|\b[1-9]\b|\b[1-9]\s*(?:pcs?|pieces?|shirts?|tshirts?|polo)\b/i

export function poloColourQuoteGuard({ products = [], buyerText, history = [], reply, imageUrl, english = false }) {
  const text = String(buyerText || '').replace(/[?!.,]+$/g, '').trim()
  const output = String(reply || '')
  if (imageUrl || text.length > 160 || output.length > 420) return null
  const colour = text.match(/\b(navy(?:\s+blue)?|blue|black|white|maroon|grey|gray|charcoal|red)\b/i)
  if (!colour || !/\bpolo\b/i.test(text)) return null
  let quantity = null
  const plain = text.replace(/\b(\d+)\s*(?:pcs?|pieces?)\b/gi, (_, number) => {
    if (quantity !== null || Number(number) < 10 || Number(number) > 100000) quantity = NaN
    else quantity = Number(number)
    return ' '
  }).replace(colour[0], ' ')
  if (Number.isNaN(quantity) || !/^(?:(?:hi|hello|sir|please|pls|we|i|need|want|required|require|polo|t[ -]?shirts?|price|prices|rate|rates|ka|ki|ke|hai|hain|chahiye|chaiye)\s*)+$/i.test(plain.trim())) return null
  const recent = history.filter(row => !Number.isFinite(Date.parse(row.createdAt)) || Date.now() - Date.parse(row.createdAt) < 2 * 3600000)
  if (recent.some(row => row.isMedia || /\bsizes?\b|\b(?:xxs|xs|s|m|l|xl|xxl|xxxl|samples?|36|38|40|42|44|46)\b|\b[1-9]\s*(?:pcs?|pieces?)\b|\[(?:image|audio|video)\]/i.test(String(row.deferReason === 'manual_reply' ? row.aiReply || '' : row.buyerMessage || '').replace(/https?:\/\/\S+/gi, '').replace(/\b(?:[1-9]\d+)\s*(?:pcs?|pieces?)\b/gi, '')))) return null
  if (/\[(?:DEFER|SKIP)\]|\b(?:sizes?|samples?|stock|available|delivery|refund|discount|code|fabric|polyester|printing|print|complaint|deposit|advance|gst|tax|from|starts?|range)\b|\d\s*[–-]\s*₹?\s*\d/i.test(output)) return null
  const selected = ['cotton-polo', 'premium-polo'].map(slug => products.filter(p => p.slug === slug))
  if (selected.some(matches => matches.length !== 1)) return null
  const polos = selected.map(matches => matches[0])
  const requested = colour[1].toLowerCase().replace('navy blue', 'navy').replace('gray', 'grey')
  const ranges = []
  for (const p of polos) {
    if (!Array.isArray(p.colors) || !Array.isArray(p.sizes) || !p.sizes.length || !Array.isArray(p.rates)) return null
    const matches = p.colors.filter(c => requested === 'blue' ? /^(?:navy(?: blue)?|royal blue|sky(?: blue)?|blue)$/i.test(c) : c.toLowerCase() === requested)
    if (matches.length !== 1) return null
    const rates = p.rates.filter(r => r.colors?.includes(matches[0]))
    if (rates.length !== 1 || !rates[0].pricePerSize || Object.keys(rates[0].pricePerSize).length !== p.sizes.length) return null
    const prices = p.sizes.map(size => rates[0].pricePerSize[size])
    if (prices.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) return null
    ranges.push({ colour: matches[0], min: Math.min(...prices), max: Math.max(...prices) })
  }
  if (ranges[0].colour !== ranges[1].colour || ranges.every(r => r.min === r.max)) return null
  const namedPrice = /\b(Cotton Polo|Premium Polo)\s*(?:is\s+)?(?:[:—–-]\s*)?(?:₹\s*|rs\.?\s*)(\d+(?:\.\d+)?)/gi
  const quoted = [...output.matchAll(namedPrice)]
  if (quoted.length !== 2 || new Set(quoted.map(m => m[1].toLowerCase())).size !== 2) return null
  if (quoted.some(m => Number(m[2]) !== ranges[/^cotton/i.test(m[1]) ? 0 : 1].min)) return null
  const remainder = output.replace(/https?:\/\/\S+/gi, '').replace(namedPrice, '').replace(/\b10\s*\+/g, '').replace(/\b\d+\s*(?:pcs?|pieces?)\b/gi, match => Number(match.match(/\d+/)[0]) === quantity ? '' : match)
  if (/\d/.test(remainder)) return null
  const words = remainder.replace(/[^a-z]+/gi, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.some(w => !/^(?:hi|hello|sir|polo|comes|in|navy|blue|black|white|maroon|grey|gray|charcoal|red|bulk|rate|rates|price|prices|pcs?|pieces?|per|each|and|or|is|are|at|for|the|pe|mein|hai|hain|ka|ke|ki|aur)$/i.test(w))) return null
  const names = ['Cotton Polo', 'Premium Polo']
  const prices = ranges.map((r, i) => `${names[i]} ₹${r.min}${r.min === r.max ? '' : `–₹${r.max}`}`).join('; ')
  const useEnglish = english || !/\b(?:ka|ki|ke|hai|hain|chahiye|chaiye)\b/i.test(text)
  return `${ranges[0].colour}: ${prices} bulk (10+ total pcs, ${useEnglish ? 'by size' : 'size ke hisaab se'}) sir 👉 https://sale91.com/catalog`
}

export function poloRateSummaryGuard({ products = [], buyerText, history = [], reply, english = false }) {
  const text = String(buyerText || '').trim().replace(/[?!.,]+$/g, '').trim()
  const output = String(reply || '')
  if (!/\bpolos?\b/i.test(text) || !SIMPLE_POLO_ASK.test(text) || text.length > 100) return null
  if (!/\bcotton\s+polo\b/i.test(output) || !/\bpremium\s+polo\b/i.test(output)) return null
  if (!/(?:₹\s*|\brs\.?\s*)\d/i.test(output) || output.length > 300) return null
  if (/\[(?:DEFER|SKIP)\]|\b(?:sample|stock|available|delivery|refund|discount|code|fabric|polyester|printing|print|complaint)\b/i.test(output)) return null
  if (SELECTED_VARIANT.test(output) || /\b(?:from|starts?|range)\b|₹\s*\d+\s*[–-]\s*₹?\s*\d+/i.test(output)) return null
  if (history.some(row => {
    const prior = String(row.deferReason === 'manual_reply' ? row.aiReply || '' : row.buyerMessage || '').replace(/https?:\/\/\S+/gi, '')
    return SELECTED_VARIANT.test(prior) || SAMPLE_ORDER.test(prior)
  })) return null
  const selected = ['cotton-polo', 'premium-polo'].map(slug => products.filter(p => p.slug === slug))
  if (selected.some(matches => matches.length !== 1)) return null
  const polos = selected.map(matches => matches[0])
  if (polos.some(p => !Array.isArray(p.bulkRange) || p.bulkRange.length !== 2 || p.bulkRange.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0) || p.bulkRange[0] > p.bulkRange[1])) return null
  const gsmMentions = [...output.matchAll(/\b(\d{3})\s*gsm\b/gi)]
  if (gsmMentions.some(m => polos.some(p => p.gsm !== Number(m[1])))) return null
  const summaryOnly = output.replace(/^polo\s+(?:2\s+hain|comes\s+in\s+2\s+options|mein\s+2\s+options?\s+hain?)(?:\s+sir)?\s*[—–:-]\s*(?=Cotton\s+polo\b)/i, '').replace(/https?:\/\/\S+/gi, '').replace(/(?:₹\s*|\brs\.?\s*)\d+(?:\.\d+)?/gi, '').replace(/\b10\s*\+/g, '').replace(/\b\d{3}\s*gsm\b/gi, '')
  if (/\d/.test(summaryOnly)) return null
  const summaryWords = summaryOnly.replace(/[^a-z]+/gi, ' ').trim().split(/\s+/)
  if (summaryWords.some(word => !/^(?:cotton|premium|polo|polos|bulk|pcs?|pieces?|per|each|and|or|is|are|at|for|in|the|price|prices|rate|rates|hai|hain|sir|pe|mein|ka|ke|ki|aur)$/i.test(word))) return null
  const names = ['Cotton Polo', 'Premium Polo']
  const prices = polos.map((p, i) => `${names[i]} ₹${p.bulkRange[0]}${p.bulkRange[0] === p.bulkRange[1] ? '' : `–₹${p.bulkRange[1]}`}`).join('; ')
  return `${prices}${gsmMentions.length ? ` (${polos[0].gsm}gsm)` : ''} bulk (10+ total pcs, ${english ? 'by colour/size' : 'colour/size ke hisaab se'}) sir 👉 https://sale91.com/catalog`
}
