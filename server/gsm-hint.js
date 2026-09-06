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
    const opts = hits.map(p => `${p.title}${p.bulk ? ` (bulk ₹${p.bulk})` : ''}`).join(' · ')
    // "240 gsm" nearly always means the plain Oversize 240 tee; AcidWash / Shorts at the same GSM
    // are speciality lines, not a different FIT — lead with the plain tee, mention the rest, no
    // question. Ask the fit only when the candidates are genuinely different fits (regular round
    // neck vs oversize, as at 180gsm).
    const plain = hits.filter(p => /^oversize\s*\d+\s*gsm$/i.test(p.title))
    const otherFits = hits.some(p => /round\s*neck|polo|hoodie|sweat|boxy|kids/i.test(p.title))
    if (plain.length === 1 && !otherFits) {
      lines.push(`- ${g}gsm exists in ${hits.length} products: ${opts} → LEAD with ${plain[0].title}${plain[0].bulk ? ` ₹${plain[0].bulk}` : ''} as the answer and mention the other(s) in the same line; do NOT ask which.`)
    } else {
      lines.push(`- ${g}gsm exists in ${hits.length} products: ${opts} → different fits: name the options and ASK the fit.`)
    }
  }
  if (!lines.length) return null
  return [
    '🔎 GSM ALONE IS NOT A PRODUCT (resolved in code from the catalog — the buyer named a GSM but no fit or product in this message):',
    ...lines,
    'HOW TO ANSWER: if the RECENT CONVERSATION already fixes the fit or product, answer for that one only. Otherwise follow the arrow on each line: "ASK the fit" → name the options with these catalog prices in ONE line and ask (e.g. "180gsm mein regular round neck (True Bio ₹150 / Bio ₹142) aur oversize ₹177 hai sir — kaunsa fit chahiye? 👉 https://sale91.com/catalog"); "LEAD with" → give that price directly and add the other line(s) in the same breath. Never call one of them "fixed price" as if it were the only product at that GSM.',
  ].join('\n')
}
