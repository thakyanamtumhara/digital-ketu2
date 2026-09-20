export function purchaseMinimumGuard({ buyerText, reply, imageUrl, english = false }) {
  if (imageUrl || !english) return null
  const buyer = String(buyerText || '').trim()
  const output = String(reply || '').trim()
  if (buyer.length > 240 || output.length > 350) return null
  if (!/\bbulk\b/i.test(buyer) || !/\b(?:buy|need|want)\b/i.test(buyer)) return null
  if (/\b(?:custom|print\w*|embroider\w*|label\w*|pack\w*|bundle\w*|discount\w*|coupon\w*|refund\w*|paid|payment|sample\w*)\b/i.test(buyer)) return null
  const quantities = [...buyer.matchAll(/\b(\d{1,5})\s*(?:pcs?|pieces?)\b/gi)]
  if (quantities.length !== 1 || Number(quantities[0][1]) <= 10) return null
  const match = output.match(/^((?:Oversize\s+)?(180|210|240|260)\s*gsm bulk rate ₹\d+(?:\.\d+)?\/pc(?: sir| bhai)?),\s*(\d{1,5})\s*(?:pcs?|pieces?) minimum( with all colou?rs\/sizes mix available)?\s*👉\s*(https:\/\/(?:www\.)?(?:sale91\.com|bulkplaintshirt\.com)\/catalog\/p\/oversize-(?:180|210|240|260)gsm\/?)$/i)
  if (!match || match[3] !== quantities[0][1] || !match[5].endsWith(`oversize-${match[2]}gsm`) && !match[5].endsWith(`oversize-${match[2]}gsm/`)) return null
  return `${match[1]} — no minimum order; bulk rate applies at 10+ total pcs${match[4] ? ', colours/sizes can be mixed' : ''} 👉 ${match[5]}`
}
