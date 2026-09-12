import { resolveTimedFactProduct, detectColoursAndSizes, PRODUCT_NAMED_RE } from './stock-lookup.js'

const POINTER = /\bcoming\s*soon\b/i
const TIMING = /\b(?:restock|refill|kab|when)\b/i
const MISSING = /\b(?:no\s+(?:information|info|update)|not\s+(?:there|listed|mentioned)|can'?t\s+find|(?:information|info|update|usme|wahan|wahin)[^.!?]{0,35}\b(?:nahi|nhi|nai))\b/i
const OTHER_TASK = /\b(?:price|rate|cost|discount|coupon|photo|photos|catalog|catalogue|contact|number|address|payment|refund|return|dispatch|delivery|parcel|order|print|printing|size\s+chart)\b/i
const ESTIMATE = /\b\d+\s*(?:[-–]\s*\d+\s*)?(?:days?|din|weeks?|hafte?)\b|\b(?:today|tomorrow|aaj|kal|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
const POINTER_WORDS = new Set('coming soon tab section page mein me mai main par pe per ki ka ke ko se sir bhai bhaiya ji please pls plz check dekho dekhiye dekh lijiye lijie lo kar karo karlo karke karte kijiye kr rahiye raho rahe wahin wahan yahin yahan usi usme update updates aata aate ata ate rehta rehte hota hote rahta rahte hai hain h hi to toh wah wahi timing timings information info milti milta milegi milengi mil jayegi jati jaati ye yeh aap apko aapko the this that there it is in on at gets updated regularly keep checking for restock stock and can you find see shown mentioned available details are will be shown'.split(' '))
const plain = value => String(value || '').replace(/https?:\/\/\S+/gi, ' ').trim()

function onlyPointer(reply) {
  if (!POINTER.test(reply) || /\[(?:DEFER|SKIP)\]/.test(reply)) return false
  const words = plain(reply).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every(word => POINTER_WORDS.has(word))
}

export function restockPointerGuard({ buyerText, history = [], reply, now = Date.now() }) {
  if (!onlyPointer(reply)) return null
  const text = plain(buyerText)
  if ((!TIMING.test(text) && !MISSING.test(text)) || OTHER_TASK.test(text)) return null
  const previous = Array.isArray(history) ? history.at(-1) : null
  if (!previous || previous.status !== 'REPLIED' || previous.deferReason === 'manual_reply' || !POINTER.test(previous.aiReply || '') || ESTIMATE.test(previous.aiReply || '')) return null
  const age = now - Date.parse(previous.createdAt)
  if (!Number.isFinite(age) || age < 0 || age > 6 * 3600000) return null
  const subject = resolveTimedFactProduct(previous.buyerMessage)
  if (!subject) return null
  const currentSubject = resolveTimedFactProduct(text)
  if (currentSubject ? currentSubject !== subject : PRODUCT_NAMED_RE.test(text)) return null
  const before = detectColoursAndSizes(previous.buyerMessage)
  const current = detectColoursAndSizes(text)
  if (current.colours.some(colour => !before.colours.includes(colour)) || current.sizes.some(size => !before.sizes.includes(size))) return null
  return '[DEFER]'
}
