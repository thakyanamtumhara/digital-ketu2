export function sublimationPriceGuard({ products = [], buyerText, history = [], reply, imageUrl, now = Date.now() }) {
  const text = String(buyerText || '').trim()
  const output = String(reply || '')
  const ask = /^(?:(?:hi|hello|sir|please|pls|share|send|me|i|we|need|want|polyester|sublimation|t[ -]?shirts?|price|prices|rate|rates|ka|ki|ke|hai|hain|kya)\s*)+$/i
  if (imageUrl || text.length > 120 || !ask.test(text.replace(/[?!.,]/g, ' ')) || !/\b(?:polyester|sublimation)\b/i.test(text) || !/\b(?:price|prices|rate|rates)\b/i.test(text)) return null
  if (!output || output.length > 350 || !/\bsublimation\s+t[ -]?shirts?\b/i.test(output)) return null
  if (/\[(?:DEFER|SKIP)\]|\b(?:size|sizes|stock|available|delivery|refund|discount|code|print|printing|complaint|deposit|advance|gst|tax|from|starts?|range|hoodie|polo|oversize)\b|\d\s*[–-]\s*₹?\s*\d/i.test(output)) return null
  if (!Array.isArray(history) || history.some(row => {
    const at = Date.parse(row.createdAt)
    if (Number.isFinite(at) && now - at > 2 * 3600000) return false
    const prior = String(row.buyerMessage || '').trim()
    return row.deferReason === 'manual_reply' || row.isMedia || !/^(?:(?:hi|hello|hey|hii|sir|ji)\s*)*[.!?]*$/i.test(prior)
  })) return null
  const matches = products.filter(p => p.slug === 'sublimation-t-shirt')
  if (matches.length !== 1) return null
  const product = matches[0]
  if (!Array.isArray(product.colors) || product.colors.length !== 1 || product.colors[0] !== 'White' || !Array.isArray(product.sizes) || !product.sizes.length || new Set(product.sizes).size !== product.sizes.length || !Array.isArray(product.rates) || product.rates.length !== 1) return null
  const rate = product.rates[0]
  if (!Array.isArray(rate.colors) || rate.colors.length !== 1 || rate.colors[0] !== 'White' || !rate.pricePerSize || Object.keys(rate.pricePerSize).length !== product.sizes.length) return null
  const prices = product.sizes.map(size => rate.pricePerSize[size])
  if (prices.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) return null
  const min = Math.min(...prices), max = Math.max(...prices)
  if (min === max) return null
  const pricePattern = /(?:₹\s*|\brs\.?\s*)(\d+(?:\.\d+)?)/gi
  const quotes = [...output.matchAll(pricePattern)]
  if (quotes.length < 1 || quotes.length > 2 || Number(quotes[0][1]) !== min) return null
  if (!/\b10\s*\+\s*(?:total\s+)?(?:pcs?|pieces?)\b/i.test(output)) return null
  if (/\bsamples?\b/i.test(output.slice(0, quotes[0].index))) return null
  if (quotes.length === 2) {
    if (!/\bsample\s*$/i.test(output.slice(quotes[0].index + quotes[0][0].length, quotes[1].index))) return null
    if (!Array.isArray(product.sampleRange) || product.sampleRange.length !== 2 || product.sampleRange[0] !== product.sampleRange[1] || typeof product.sampleRange[0] !== 'number' || Number(quotes[1][1]) !== product.sampleRange[0]) return null
  } else if (/\bsamples?\b/i.test(output)) return null
  const urls = output.match(/https?:\/\/\S+/gi) || []
  if (urls.some(url => !/^https:\/\/(?:www\.)?sale91\.com\/catalog\/p\/sublimation-t-shirt\/?$/.test(url))) return null
  const rest = output.replace(/https?:\/\/\S+/gi, '').replace(pricePattern, '').replace(/\b10\s*\+/g, '')
  if (/\d/.test(rest)) return null
  const words = rest.replace(/[^a-z]+/gi, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.some(word => !/^(?:polyester|sublimation|t|shirt|shirts|tshirt|tshirts|white|only|sirf|sir|mein|hai|hain|ka|ki|ke|pe|bulk|sample|pcs?|pieces?|per|each|for|total|is|are|at|the|price|rate|and|or)$/i.test(word))) return null
  return output.slice(0, quotes[0].index) + `₹${min}–₹${max} (${ /\b(?:mein|hai|hain|ka|ki|ke|sirf)\b/i.test(output) ? 'size ke hisaab se' : 'by size'})` + output.slice(quotes[0].index + quotes[0][0].length)
}
