export const STOCK_ALERT_URL = 'https://www.bulkplaintshirt.com/delhi-stock.html?alert=1'

const HOSTS = new Set(['sale91.com', 'www.sale91.com', 'bulkplaintshirt.com', 'www.bulkplaintshirt.com'])
const ALERT_OFFER = /\bstock\s*alerts?\b|\bwhatsapp\s+(?:stock\s+)?(?:alerts?|notifications?)\b|\b(?:set|enable|register|laga\w*)\s+(?:(?:a|an|the)\s+)?(?:stock\s+)?(?:alerts?|notifications?)\b|\balert\s+(?:laga\w*|set)\b/i

export function stockAlertUrl(whatsappNumber, selectors = null) {
  const url = new URL(STOCK_ALERT_URL)
  const raw = String(whatsappNumber || '').trim()
  const digits = /^[+\d\s()-]+$/.test(raw) ? raw.replace(/\D/g, '') : ''
  const phone = digits.replace(/^91(?=\d{10}$)/, '')
  if (/^[6-9]\d{9}$/.test(phone)) url.searchParams.set('ph', phone)
  for (const key of ['type', 'color', 'size']) {
    const value = selectors?.get(key)
    if (value) url.searchParams.set(key, value)
  }
  return url.href
}

export function canonicalizeStockAlertLinks(reply, whatsappNumber) {
  const text = String(reply || '')
  let previousLinkEnd = 0
  return text.replace(/https?:\/\/[^\s<>"']+/gi, (match, offset) => {
    const lead = text.slice(previousLinkEnd, offset).trim().split(/[.!?\n]/).filter(part => part.trim()).at(-1) || ''
    const alertOffer = ALERT_OFFER.test(lead)
    previousLinkEnd = offset + match.length
    const suffix = match.match(/[),.!;:\]]+$/)?.[0] || ''
    const raw = suffix ? match.slice(0, -suffix.length) : match
    let url
    try { url = new URL(raw.replace(/&amp;/gi, '&')) } catch { return match }
    if (!HOSTS.has(url.hostname.toLowerCase())) return match
    const stockPage = url.pathname.toLowerCase() === '/delhi-stock.html'
    const legacy = url.searchParams.get('stockalert') === '1'
    const alertPage = stockPage && (['alert', 'ph', 'phone'].some(key => url.searchParams.has(key)) || alertOffer)
    if (!legacy && !alertPage) return match
    return stockAlertUrl(whatsappNumber, stockPage ? url.searchParams : null) + suffix
  })
}
