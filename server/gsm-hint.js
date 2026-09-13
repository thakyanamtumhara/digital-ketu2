// GSM-ALONE RESOLVER (2026-09-06). A bare GSM that lives in several catalog products is not a
// product, yet the model keeps quoting one of them ("180gsm oversize ₹177" for "180 gsm pe 10+ piece
// pe kya price" — buyer 9525834529, 15:36 IST, one day after the prompt rule for exactly this).
// Same medicine as the stock resolvers: do the join in code and put the options in front of the
// model. Fires only when the message names a GSM shared by 2+ products and no product/fit word.
export const FIT_OR_PRODUCT_RE = /\b(bio|true\s*bio|non\s*bio|polo|oversize[d]?|over\s*size|drop\s*shoulder|dropshoulder|acid|acidwash|hoodie|hoody|sweat\s*shirt|kids?|bachch?o?n?|sublimation|shorts?|zip|zipper|varsity|jacket|boxy|rneck|round\s*neck|regular|premium|terry|loopknit|matty|honeycomb|fleece|brushed)\b/i

export function catalogProductsFromChunks(chunks) {
  const out = []
  for (const c of chunks || []) {
    const m = typeof c.metadata === 'string' ? (() => { try { return JSON.parse(c.metadata) } catch { return {} } })() : (c.metadata || {})
    if (!m || !m.gsm) continue
    out.push({ title: c.title, gsm: Number(m.gsm), bulk: m.bulkPrice, sample: m.samplePrice, slug: m.slug })
  }
  return out
}

export function gsmAmbiguityHint(products, text) {
  const t = String(text || '')
  const gsms = [...new Set([...t.matchAll(/\b(\d{3})\s*(?:gsm|gsn|gms|g\.s\.m)\b/gi)].map(m => Number(m[1])))]
  if (!gsms.length || FIT_OR_PRODUCT_RE.test(t)) return null
  const lines = []
  for (const g of gsms) {
    const hits = (products || []).filter(p => p.gsm === g)
    if (hits.length < 2) continue
    const opts = hits.map(p => {
      const bands = [['bulkRange', 'bulk (10+ total pcs)'], ['sampleRange', 'sample (under 10 total pcs)']].flatMap(([key, label]) => {
        const range = p[key]
        if (!Array.isArray(range) || range.length !== 2 || range.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0) || range[0] > range[1]) return []
        return [`${label} ₹${range[0]}${range[0] === range[1] ? '' : `–₹${range[1]}`} per piece`]
      })
      return `${p.title}${bands.length ? ` (${bands.join('; ')}; range across catalogue colours/sizes, not a selected variant quote)` : ' (exact rates only from AUTHORITATIVE CATALOG)'}`
    }).join(' · ')
    // "240 gsm" nearly always means the plain Oversize 240 tee; AcidWash / Shorts at the same GSM
    // are speciality lines, not a different FIT — lead with the plain tee, mention the rest, no
    // question. Ask the fit only when the candidates are genuinely different fits (regular round
    // neck vs oversize, as at 180gsm).
    const plain = hits.filter(p => /^oversize\s*\d+\s*gsm$/i.test(p.title))
    const otherFits = hits.some(p => /round\s*neck|polo|hoodie|sweat|boxy|kids/i.test(p.title))
    if (plain.length === 1 && !otherFits) {
      lines.push(`- ${g}gsm exists in ${hits.length} products: ${opts} → LEAD with ${plain[0].title} as the answer and mention the other(s) in the same line; do NOT ask which.`)
    } else {
      lines.push(`- ${g}gsm exists in ${hits.length} products: ${opts} → different fits: name the options and ASK the fit.`)
    }
  }
  if (!lines.length) return null
  return [
    '🔎 GSM ALONE IS NOT A PRODUCT (resolved in code from the catalog — the buyer named a GSM but no fit or product in this message):',
    ...lines,
    'HOW TO ANSWER: if the RECENT CONVERSATION already fixes the fit or product, answer for that one only using its exact colour/size and TOTAL-order quantity from AUTHORITATIVE CATALOG. Otherwise follow the arrow: "ASK the fit" → name the options and ask which fit; "LEAD with" → lead with the plain tee and mention the other lines. When quoting an unspecified variant, use the complete labelled bulk/sample range above or clearly say "bulk starts at"; never present a minimum as a flat price. Keep it brief and link https://sale91.com/catalog. No rate in this hint overrides a selected variant in the full catalogue.',
  ].join('\n')
}

export function gsmPriceRangeGuard({ products = [], buyerText, history = [], reply, english = false }) {
  const text = String(buyerText || '').trim()
  const gsms = [...text.matchAll(/\b(\d{3})\s*(?:gsm|gsn|gms|g\.s\.m)\b/gi)]
  if (gsms.length !== 1 || text.length > 160 || FIT_OR_PRODUCT_RE.test(text)) return null
  if (!/\b(?:prices?|rates?|catalog(?:ue)?)\b/i.test(text)) return null
  if (/\d/.test(text.replace(gsms[0][0], '')) || /\b(?:samples?|pcs?|pieces?|qty|quantity|coupon|code|discount|payment|paid|refund|return|exchange|complaint|delivery|dispatch|stock|available|restock|photos?|videos?|size|order|print(?:ing)?|embroidery|shipping|transport|courier|address|location|contact|hours?|quality|fabric)\b|\[[^\]]+\]|https?:\/\//i.test(text)) return null
  const words = text.replace(gsms[0][0], '').toLowerCase().replace(/t[\s-]?shirts?/g, 'tshirt').replace(/[^a-z]+/g, ' ').trim().split(/\s+/)
  if (/[^\x00-\x7f]/.test(text) || words.some(word => !/^(?:tshirt|tee|tees|plain|cotton|ka|ki|ke|kya|hai|hain|mein|me|mujhe|chahiye|catalog|catalogue|with|and|aur|or|price|prices|rate|rates|list|bulk|please|pls|plz|sir|hi|hello|share|send|show|give|tell|me|your|the|a|for|can|you|could|want|i|need|kijiye|kijie|kariye|kro|karo|bhejo|bhejiye|bhejna|batao|bataiye|dijiye|dikhaiye)$/.test(word))) return null
  if (history.slice(-6).some(row => {
    const prior = String(row.deferReason === 'manual_reply' ? row.aiReply || '' : row.buyerMessage || '')
    return FIT_OR_PRODUCT_RE.test(prior) || /\bsamples?\b|\d+\s*(?:pcs?|pieces?)\b/i.test(prior)
  })) return null
  if (!/(?:₹\s*|\brs\.?\s*)\d/i.test(String(reply || '')) || /\[(?:DEFER|SKIP)\]/i.test(reply)) return null
  const gsm = Number(gsms[0][1]), hits = products.filter(p => p.gsm === gsm)
  if (hits.length < 2 || !hits.some(p => /round\s*neck|polo|hoodie|sweat|boxy|kids/i.test(p.title))) return null
  if (hits.some(p => !Array.isArray(p.bulkRange) || p.bulkRange.length !== 2 || p.bulkRange.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0) || p.bulkRange[0] > p.bulkRange[1])) return null
  const options = hits.map(p => `${p.title}: ₹${p.bulkRange[0]}${p.bulkRange[0] === p.bulkRange[1] ? '' : `–₹${p.bulkRange[1]}`}`).join('; ')
  return `${gsm}gsm bulk (10+ total pcs), ${english ? 'ranges by colour/size' : 'colour/size ke hisaab se'}: ${options}. ${english ? 'Which product sir?' : 'Kaunsa product chahiye sir?'} 👉 https://sale91.com/catalog`
}
