import { resolveTimedFactProduct, detectColoursAndSizes, PRODUCT_NAMED_RE } from './stock-lookup.js'

const POINTER = /\bcoming\s*soon\b/i
const TIMING = /\b(?:restock|refill|kab|when|mangwa|mangwaa|mangva)\b/i
const MISSING = /\b(?:no\s+(?:information|info|update)|not\s+(?:there|listed|mentioned)|can'?t\s+find|(?:information|info|update|usme|isme|wahan|wahin|page)[^.!?]{0,45}\b(?:nahi|nhi|nai))\b/i
const OTHER_TASK = /\b(?:price|rate|cost|discount|coupon|photo|photos|catalog|catalogue|contact|number|address|payment|refund|return|dispatch|delivery|parcel|order|print|printing|size\s+chart)\b/i
const ESTIMATE = /\b\d+\s*(?:[-–]\s*\d+\s*)?(?:days?|din|weeks?|hafte?)\b|\b(?:today|tomorrow|aaj|kal|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
const POINTER_WORDS = new Set('coming soon tab section page mein me mai main par pe per ki ka ke ko se sir bhai bhaiya ji please pls plz check dekho dekhiye dekh lijiye lijie lo kar karo karlo karke karte kijiye kr rahiye raho rahe wahin wahan yahin yahan usi usme update updates aata aate ata ate rehta rehte hota hote rahta rahte hai hain h hi to toh wah wahi timing timings information info milti milta milegi milengi mil jayegi jati jaati ye yeh aap apko aapko the this that there it is in on at gets updated regularly keep checking for restock stock and can you find see shown mentioned available details are will be shown'.split(' '))
const NO_DATE = /\b(?:no\s+(?:known\s+)?(?:shipment|date|timing|estimate)|(?:shipment|date|timing|estimate)[^.!?]{0,25}\b(?:nahi|nhi|nai|unknown))\b/i
const NO_DATE_WORDS = new Set([...POINTER_WORDS, ...'abhi koi nahi nhi nai no not known unknown yet listed list uss us iska bata sakta sakte cannot tell give date estimate shipment aur or out of acid wash acidwash os oversize oversized gsm biowash bio true round neck rneck cotton premium polo kids hoodie sweatshirt black white off offwhite brown navy maroon red army green charcoal charcol grey gray beige biege lavender rose pink powder blue royal mustard yellow s m l xs xl xxl xxxl xxs 180 210 240 260 320 430 180gsm 210gsm 240gsm 260gsm 320gsm 430gsm'.split(' ')])
const plain = value => String(value || '').replace(/https?:\/\/\S+/gi, ' ').trim()

function onlyPointer(reply) {
  if (!POINTER.test(reply) || /\[(?:DEFER|SKIP)\]/.test(reply)) return false
  const words = plain(reply).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every(word => POINTER_WORDS.has(word))
}

function onlyNoDate(reply) {
  if (!NO_DATE.test(reply) || ESTIMATE.test(reply) || /\[(?:DEFER|SKIP)\]/.test(reply)) return false
  const text = plain(reply).replace(/\bjo\s+(?:abhi\s+)?available\s+hai\s*(?:wo\s+)?le\s+lijiye\b/gi, '')
  if (/\bavailable\b/i.test(text)) return false
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every(word => NO_DATE_WORDS.has(word))
}

export function restockPointerGuard({ buyerText, history = [], reply, now = Date.now() }) {
  const pointerOnly = onlyPointer(reply)
  if (!pointerOnly && !onlyNoDate(reply)) return null
  const text = plain(buyerText)
  if ((!TIMING.test(text) && !MISSING.test(text)) || OTHER_TASK.test(text)) return null
  const previous = Array.isArray(history) ? history.at(-1) : null
  if (!previous || previous.status !== 'REPLIED' || previous.deferReason === 'manual_reply' || (!POINTER.test(previous.aiReply || '') && !onlyNoDate(previous.aiReply || '')) || ESTIMATE.test(previous.aiReply || '')) return null
  const age = now - Date.parse(previous.createdAt)
  if (!Number.isFinite(age) || age < 0 || age > 6 * 3600000) return null
  const priorBuyerSubject = resolveTimedFactProduct(previous.buyerMessage)
  if (!priorBuyerSubject && PRODUCT_NAMED_RE.test(previous.buyerMessage || '')) return null
  const subject = priorBuyerSubject || resolveTimedFactProduct(previous.aiReply)
  if (!subject) return null
  const currentSubject = resolveTimedFactProduct(text)
  if (currentSubject ? currentSubject !== subject : PRODUCT_NAMED_RE.test(text)) return null
  const before = detectColoursAndSizes(`${previous.buyerMessage || ''} ${previous.aiReply || ''}`)
  const current = detectColoursAndSizes(text)
  if (current.colours.some(colour => !before.colours.includes(colour)) || current.sizes.some(size => !before.sizes.includes(size))) return null
  if (!pointerOnly) {
    const replySubject = resolveTimedFactProduct(reply)
    if (replySubject && replySubject !== subject) return null
    const repeated = detectColoursAndSizes(reply)
    if (repeated.colours.some(colour => !before.colours.includes(colour)) || repeated.sizes.some(size => !before.sizes.includes(size))) return null
  }
  return '[DEFER]'
}
