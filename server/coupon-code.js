const CODE_TOPIC = /\b(?:(?:discount|promo|coupon)\s+codes?|coupons?)\b/i
const PIECE_COUNT = /\b[1-9]\d{0,4}\s*(?:pcs?|pieces?|peices?|pices?|units?|t[ -]?shirts?|shirts?|hoodies?|sweatshirts?|polos?)\b/i
const REQUEST_WORDS = new Set('yes yeah i we my our want need would like to know have has is are there a an any some please pls plz sir bhai bhaiya for the this order total of can could you give send share get me us koi kya hai hain mujhe hame chahiye milega milegi de do dedo dijiye dena batao bataiye ka ki ke mein me'.split(' '))
const plainText = value => String(value || '').replace(/https?:\/\/\S+/gi, ' ').trim()

export function couponCodeGuard({ buyerText, history = [], reply }) {
  if (!reply || /\[(?:DEFER|SKIP)\]/.test(reply)) return null
  const text = plainText(buyerText)
  if (!CODE_TOPIC.test(text)) return null
  const remaining = text.replace(new RegExp(CODE_TOPIC.source, 'gi'), ' ')
    .replace(new RegExp(PIECE_COUNT.source, 'gi'), ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (remaining.some(word => !REQUEST_WORDS.has(word))) return null
  const buyerTurns = (Array.isArray(history) ? history : [])
    .filter(row => row && row.deferReason !== 'manual_reply')
    .map(row => plainText(row.buyerMessage))
  if (![text, ...buyerTurns].some(turn => PIECE_COUNT.test(turn))) return null
  return '[DEFER]'
}
