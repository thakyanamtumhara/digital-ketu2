const CODE_TOPIC = /\b(?:(?:discount|promo|coupon)\s+codes?|discount\s+ode|coupons?)\b/i
const PIECE_COUNT = /\b[1-9]\d{0,4}\s*(?:pcs?|pieces?|peices?|pices?|units?|t[ -]?shirts?|shirts?|hoodies?|sweatshirts?|polos?)\b/i
const REQUEST_WORDS = new Set('yes yeah i we my our want need would like to know have has is are there a an any some please kindly pls plz sir bhai bhaiya for the this order place hoodie hoodies sweatshirt sweatshirts tshirt tshirts shirt shirts total of can could you give send share get me us koi kya hai hain mujhe hame chahiye milega milegi de do dedo dijiye dena batao bataiye ka ki ke mein me'.split(' '))
const REFUSAL_WORDS = new Set('fixed price prices sir we work working are on with a very tight margin margins no coupon coupons discount promo code codes available'.split(' '))
const plainText = value => String(value || '').replace(/https?:\/\/\S+/gi, ' ').trim()

export function isConflictingCouponCorrection(row) {
  if (row?.source !== 'CORRECTION') return false
  const pair = /^\s*Buyer:\s*([\s\S]*?)\nCorrect reply:\s*([\s\S]+)$/i.exec(row.content || '')
  if (!pair || !CODE_TOPIC.test(pair[1]) || !/\b(?:give|send|provide|want|need|any|koi|de|do|dena|chahiye|milega)\b/i.test(pair[1])) return false
  const answer = typeof row.metadata?.correctReply === 'string' ? row.metadata.correctReply : pair[2]
  const words = answer.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/)
  return (/\bfixed prices?\b|\bno (?:coupon|discount|promo)\b/i.test(answer) && words.every(word => REFUSAL_WORDS.has(word)))
    || /^\s*Website pe hai\s*,?\s*jo bhi hai sir[\s.,!🙏]+Manually nothing allowed now sir[\s.,!🙏]*$/i.test(answer)
}

export function couponCodeGuard({ buyerText, history = [], reply }) {
  if (!reply || /\[(?:DEFER|SKIP)\]/.test(reply)) return null
  const text = plainText(buyerText)
  if (!CODE_TOPIC.test(text)) return null
  const remaining = text.replace(new RegExp(CODE_TOPIC.source, 'gi'), ' ')
    .replace(new RegExp(PIECE_COUNT.source, 'gi'), ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (remaining.some(word => !REQUEST_WORDS.has(word))) return null
  const rows = Array.isArray(history) ? history : []
  const latestOwner = rows.findLast(row => row?.deferReason === 'manual_reply')
  const ownerPiecePromise = /^(?:ok(?:ay)?[,.!]?\s*)?(?:i\s+)?(?:will\s+add\s+[1-9]\d{0,4}\s*(?:pcs?|pieces?)|[1-9]\d{0,4}\s*(?:pcs?|pieces?)\s+(?:i\s+)?will\s+add)[.!]?$/i.test(plainText(latestOwner?.aiReply))
  const buyerTurns = rows
    .filter(row => row && row.deferReason !== 'manual_reply')
    .map(row => plainText(row.buyerMessage))
  if (!ownerPiecePromise && ![text, ...buyerTurns].some(turn => PIECE_COUNT.test(turn))) return null
  return '[DEFER]'
}
