import { stockAlertUrl } from './stock-alert-link.js'
import { detectColoursAndSizes, resolveTimedFactProduct, PRODUCT_NAMED_RE } from './stock-lookup.js'

const POINTER = /\bcoming\s*soon\b/i
const STOCK = /\b(?:restock\w*|refill\w*|stock|shipment)\b/i
const TIMING = /\b(?:kab|when|milega|milegi|aayega|aayegi|aayenge|aaega|ayega|mangwa\w*|mangva\w*|weeks?|days?|din|hafte?|hafton)\b/i
const AVAILABILITY = /\bavailab(?:le|ility)\b|\b(?:hai|hain|h)\s*(?:kya\b|\?)/i
const MISSING = /\b(?:no\s+(?:information|info|update)|not\s+(?:there|listed|mentioned)|can'?t\s+find|(?:information|info|update|usme|isme|wahan|page)[^.!?]{0,35}\b(?:nahi|nhi|nai))\b/i
const OTHER_TASK = /\b(?:order|tracking|parcel|courier|delivery|dispatch\w*|invoice|bill|payment|refund|return|complaint)\b/i
const OUT = /\bout\s+of\s+stock\b|\bsold\s*out\b|\bstock\s*(?:mein|me)?\s*(?:nahi|nhi|khatam)\b/i
const NO_DATE = /\bno\s+(?:(?:known|confirmed)\s+)?(?:shipment|date|timing|estimate)\b|\b(?:shipment|date|timing|estimate)[^.!?\n]{0,35}\b(?:nahi|nhi|unknown)\b|\b(?:cannot|can't)\s+(?:give|confirm)[^.!?\n]{0,15}\bdate\b/i
const ETA = /\b\d+\s*(?:(?:[-–]|to|se)\s*\d+\s*)?(?:days?|din|weeks?|hafte?)\b|\b(?:today|tomorrow|aaj|kal|parso|next\s+week|agle\s+hafte)\b/i
const PERMANENT = /\b(?:discontinued|not\s+made|not\s+offered|never\s+make|do(?:n't|\s+not)\s+make|no\s+plans?|out\s+for\s+good)\b|\b(?:won't|will\s+not)\s+(?:be\s+)?restock\w*\b|\b(?:dobara|wapas)\s+(?:nahi|nhi)\s+(?:aayeg\w*|aaeg\w*|baneg\w*)\b|\b(?:nahi|nhi)\s+(?:bant\w*|banat\w*)\b/i
const ALERT = /\bstock\s*alerts?\b|\b(?:alerts?|notifications?)\s+(?:laga\w*|set|enable)\b|\b(?:set|enable|register)\s+(?:(?:a|an|the)\s+)?(?:whatsapp\s+)?(?:stock\s+)?(?:alerts?|notifications?)\b/i
const RESEND = /\b(?:resend|send|share|bhej\w*|dobara|dubara|again|firse|phir\s*se)\b/i
const INDEPENDENT = /\b(?:price|rate|cost|discount|coupon|photo\w*|catalog\w*|contact|address|payment|refund|return|dispatch\w*|delivery|parcel|order|print\w*|chart|available\s+now|in\s+stock|available\s+hai)\b|₹/i
const POINTER_WORDS = new Set('coming soon tab section page mein me mai main par pe per ki ka ke ko se sir bhai bhaiya ji please pls plz check checking dekho dekhiye dekh lijiye lijie lo kar karo karlo karke karte kijiye kr rahiye raho rahe wahin wahan yahin yahan usi usme update updates aata aate ata ate rehta rehte hota hote rahta rahte hai hain h hi to toh wah wahi timing timings information info milti milta milegi milengi mil jayegi jati jaati ye yeh aap apko aapko the this that there it is in on at gets updated regularly keep for restock stock and can you find see shown mentioned available details are will be here'.split(' '))
const ECHO_WORDS = new Set([...POINTER_WORDS, ...'abhi koi nahi nhi nai no not known unknown yet listed list uss us iska bata sakta sakte de cannot tell give date estimate shipment filhaal aur or out of sold acid wash acidwash os oversize oversized gsm biowash bio true round neck rneck premium polo kids hoodie sweatshirt boxy fit black white off offwhite brown navy maroon red army green charcoal charcol grey gray beige biege lavender rose pink powder blue royal mustard yellow s m l xs xl xxl xxxl xxs 180 210 240 260 320 430 180gsm 210gsm 240gsm 260gsm 320gsm 430gsm alert alerts notification notifications whatsapp set an a laga lijiye aane aa jayega back when get enable register'.split(' ')])
const plain = value => String(value || '').replace(/https?:\/\/\S+/gi, ' ')
const productOf = text => resolveTimedFactProduct(text) || (/\bboxy(?:\s+fit)?\b/i.test(text || '') ? 'Boxy Fit' : null)

function scopeOf(text, previous = null) {
  const subject = productOf(text)
  if (!subject && PRODUCT_NAMED_RE.test(text || '')) return null
  const { colours, sizes } = detectColoursAndSizes(plain(text))
  const inherited = !subject || subject === previous?.product ? previous : null
  const product = subject || inherited?.product
  if (!product) return null
  return { product, colours: colours.length ? colours : inherited?.colours || [], sizes: sizes.length ? sizes : inherited?.sizes || [] }
}

function sameScope(current, previous) {
  return current && previous && current.product === previous.product
    && current.colours.every(value => previous.colours.includes(value))
    && current.sizes.every(value => previous.sizes.includes(value))
}

function hasAlert(reply) {
  return ALERT.test(plain(reply)) || /\bwhatsapp\b[^.!?\n]{0,40}\b(?:updates?|notifications?)\b|\b(?:updates?|notifications?)\b[^.!?\n]{0,40}\bwhatsapp\b/i.test(plain(reply))
}

function hasAlertLink(reply, requireForm = false) {
  const text = String(reply || '')
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+|(?<!\S)(?:www\.)?(?:sale91\.com|bulkplaintshirt\.com)(?:\/|\?)[^\s<>"']*/gi)) {
    const before = text.slice(0, match.index)
    const prefix = before.match(/\S*$/)?.[0] || ''
    if (prefix && !/^[([<"'`*]+$/.test(prefix) && !/(?:^|\s)\[[^\]\r\n]*\]\($/.test(before)) continue
    try {
      const raw = match[0].replace(/[),.!;:\]]+$/, '')
      const url = new URL((/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).replace(/&amp;/gi, '&'))
      if (!/^(?:www\.)?(?:sale91\.com|bulkplaintshirt\.com)$/i.test(url.hostname)) continue
      const stockPage = url.pathname.toLowerCase() === '/delhi-stock.html'
      if (requireForm ? stockPage && ['alert', 'ph', 'phone'].some(key => url.searchParams.has(key)) : stockPage || url.searchParams.get('stockalert') === '1') return true
    } catch {}
  }
  return false
}

function purePointer(text) {
  if (!POINTER.test(text)) return false
  const words = plain(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every(word => POINTER_WORDS.has(word))
}

function onlyStockEcho(reply) {
  const text = plain(reply).replace(/\bjo\s+(?:abhi\s+)?available\s+hai\s*(?:wo\s+)?le\s+lijiye\b/gi, '').replace(/\bcotton\s+polo\b/gi, 'polo')
    .replace(/\bexact\s+(?=date\b)/gi, '')
    .replace(/\b(alerts?|notifications?)\s+laga\s+(?:diya\s+hai\s+toh?|rakhiye)\b/gi, '$1 laga lijiye')
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (!words.length || !words.every(word => ECHO_WORDS.has(word))) return false
  return text.split(/[.!?;—\n]+/).filter(part => /\p{L}/u.test(part)).every(part => OUT.test(part) || NO_DATE.test(part) || POINTER.test(part) || hasAlert(part) || /\bwhatsapp\b/i.test(part))
}

function withoutPointers(reply) {
  const links = []
  const masked = reply.replace(/https?:\/\/[^\s]+/gi, link => `URLTOKEN${links.push(link) - 1}`)
  const restore = text => text.replace(/URLTOKEN(\d+)/g, (_, index) => links[Number(index)])
  const pieces = masked.split(/(\s*(?:[—;]|\n+|(?<=[.!?])\s+|,\s*(?=(?:coming\s*soon|(?:please\s+)?check)\b))\s*)/i)
  let kept = ''
  for (let index = 0; index < pieces.length; index += 2) {
    const piece = restore(pieces[index])
    if (!piece.trim() || purePointer(piece)) continue
    kept += (kept ? pieces[index - 1] : '') + piece
  }
  return kept.trim()
}

export function stockAlertOfferGuard({ buyerText, history = [], reply, whatsappNumber, english = false, verifiedUnavailable = false, now = Date.now() }) {
  const response = String(reply || '').trim()
  if (!response || /^\[(?:DEFER|SKIP)\]$/i.test(response) || /\[SKIP\]/i.test(response) || PERMANENT.test(plain(response))) return null
  if (/\b(?:which|kaun\s*sa|kaunsa|konsa)\b/i.test(plain(response))) return null
  const buyer = plain(buyerText)
  const recent = []
  let scope = null
  for (const row of Array.isArray(history) ? history : []) {
    const age = now - Date.parse(row.createdAt)
    if (!Number.isFinite(age) || age < 0 || age > 6 * 3600000) continue
    const answerScope = scopeOf(plain(row.aiReply).split(/[.!?\n;—]/)[0], scope)
    scope = scopeOf(row.buyerMessage, answerScope || scope)
    recent.push({ row, scope })
  }
  const current = scopeOf(buyer, scope)
  const explicitStock = STOCK.test(buyer)
  if (OTHER_TASK.test(buyer) && !explicitStock) return null
  const resend = RESEND.test(buyer) && /\b(?:link|alert|notify|notification)\b/i.test(buyer)
  if (!current || (!explicitStock && !TIMING.test(buyer) && !AVAILABILITY.test(buyer) && !MISSING.test(buyer) && !resend)) return null
  const content = plain(response)
  const eligible = POINTER.test(content) || OUT.test(content) || NO_DATE.test(content) || (verifiedUnavailable && ETA.test(content))
  const offered = hasAlert(response)
  if (!eligible && !offered) return null
  const priorOffer = recent.some(({ row, scope: oldScope }) => (row.status === 'REPLIED' || row.deferReason === 'manual_reply') && sameScope(current, oldScope) && hasAlert(row.aiReply) && hasAlertLink(row.aiReply, true))
  if (priorOffer && !resend) {
    const independent = content.replace(/\bjo\s+(?:abhi\s+)?available\s+hai\s*(?:wo\s+)?le\s+lijiye\b/gi, '')
    if (!ETA.test(content) && !INDEPENDENT.test(independent) && onlyStockEcho(response) && !/\[DEFER\]/i.test(response)) return '[DEFER]'
    return null
  }
  if (offered) {
    if (hasAlertLink(response)) return null
    const suffix = /\[DEFER\]/i.test(response) ? '\n[DEFER]' : ''
    return response.replace(/\s*\[DEFER\]\s*/gi, ' ').trim() + ' 👉 ' + stockAlertUrl(whatsappNumber) + suffix
  }
  const suffix = /\[DEFER\]/i.test(response) ? '\n[DEFER]' : ''
  const body = withoutPointers(response.replace(/\s*\[DEFER\]\s*/gi, ' ').trim())
  const offer = english
    ? 'Set an alert here sir; you will get a WhatsApp when it is back 👉 '
    : 'Alert laga lijiye sir, stock aane par WhatsApp aa jayega 👉 '
  const invitation = hasAlertLink(body) ? offer.replace(/\s*👉\s*$/, '') : offer + stockAlertUrl(whatsappNumber)
  return [body, invitation].filter(Boolean).join('\n') + suffix
}
