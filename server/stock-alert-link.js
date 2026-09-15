export const STOCK_ALERT_URL = 'https://www.bulkplaintshirt.com/delhi-stock.html?alert=1'

const HOSTS = new Set(['sale91.com', 'www.sale91.com', 'bulkplaintshirt.com', 'www.bulkplaintshirt.com'])

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
  return text.replace(/https?:\/\/[^\s<>"']+|(?<!\S)(?:www\.)?(?:sale91\.com|bulkplaintshirt\.com)(?:\/|\?)[^\s<>"']*/gi, (match, offset) => {
    const before = text.slice(0, offset)
    const tokenPrefix = before.match(/\S*$/)?.[0] || ''
    if (tokenPrefix && !/^[([<"'`*]+$/.test(tokenPrefix) && !/(?:^|\s)\[[^\]\r\n]*\]\($/.test(before)) return match
    const suffix = match.match(/[),.!;:\]]+$/)?.[0] || ''
    const raw = suffix ? match.slice(0, -suffix.length) : match
    let url
    try { url = new URL((/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).replace(/&amp;/gi, '&')) } catch { return match }
    if (!HOSTS.has(url.hostname.toLowerCase())) return match
    const stockPage = url.pathname.toLowerCase() === '/delhi-stock.html'
    const legacy = url.searchParams.get('stockalert') === '1'
    if (!legacy && !stockPage) return match
    return stockAlertUrl(whatsappNumber, stockPage ? url.searchParams : null) + suffix
  })
}
