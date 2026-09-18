const SIMPLE_POLO_ASK = /^(?:(?:i|we)\s+(?:need|want)\s+)?(?:(?:hi|hello|sir|please|pls|plz|share|send|tell|me|the|your|both|details?|of|t[- ]?shirts?|ka|ki|ke|kya|hai|hain|rate|rates|price|prices|list|polo|polos)\s*)+$/i
const SELECTED_VARIANT = /\b(?:size|sizes|xxs|xs|s|m|l|xl|xxl|xxxl|20|22|24|26|28|30|32|34|36|38|40|42|44|46|black|white|navy|grey|gray|maroon|charcoal|red|kids?|child(?:ren)?)\b/i
const SAMPLE_ORDER = /\bsamples?\b|\b[1-9]\b|\b[1-9]\s*(?:pcs?|pieces?|shirts?|tshirts?|polo)\b/i

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
