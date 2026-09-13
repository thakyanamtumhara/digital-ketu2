const PRICE_CONTEXT = /\b(?:prices?|rates?|costs?|rupees?|rup(?:ee|ay|ai|iy|y)[a-z]*|rs\.?|inr|keemat|kimat|daam)\b|₹|रुप[एयेैय]|कीमत|मूल्य|प्रा[इई][सजज़]|रेट/iu
const PRICE_CHANGE = /\b(?:increas\w*|decreas\w*|rais(?:e|ed)|reduc\w*|chang\w*|differen\w*|higher|lower|risen|rose|went\s+up|used\s+to|pehle|pahle|bad[hae]\w*|badh\w*|far[akq]+|fark|meh[ae]ng\w*)\b|फ़?र[क़्क]|अंतर|बढ़|बढ|घट|महंग|महँग|पहले/iu
const MONEY_AMOUNT = /(?:₹|\b(?:rs\.?|inr))\s*\d|\d[\d,.]*(?:\s*(?:-|–|to|se)\s*\d[\d,.]*)?\s*(?:₹|rupees?\b|rup(?:ee|ay|ai|iy|y)[a-z]*\b|rs\b|रुप[एयेैय])/iu

export function isPerishablePriceChange({ buyerQuestion, correctReply }) {
  const normalize = text => String(text || '').normalize('NFKC').replace(/[०-९]/g, n => String(n.charCodeAt(0) - 0x0966))
  const reply = normalize(correctReply).replace(/https?:\/\/\S+/gi, ' ')
  const question = normalize(buyerQuestion).replace(/https?:\/\/\S+/gi, ' ')
  if (!/\d/.test(reply) || !PRICE_CONTEXT.test(`${question}\n${reply}`)) return false
  const quantityDiscount = /\d+\s*\+?\s*(?:pcs|pieces?)\b/iu.test(reply) && /\bdiscount\b|छूट/iu.test(reply)
  const historicalChange = /\b(?:increas\w*|rais(?:e|ed)|differen\w*|higher|risen|rose|went\s+up|used\s+to|today|yesterday|now|this\s+(?:week|month)|last\s+(?:week|month)|pehle|pahle|abhi|aaj|kal)\b|फ़?र[क़्क]|अंतर|पहले|बढ़|बढ|आज|कल/iu.test(reply)
  if (quantityDiscount && !historicalChange) return false
  if (MONEY_AMOUNT.test(reply) && PRICE_CHANGE.test(reply)) return true
  if (/\b(?:price|rate|cost)\b.{0,30}\bfrom\s+\d.{0,20}\bto\s+\d/iu.test(reply)) return true
  if (!PRICE_CHANGE.test(question)) return false
  return /^(?:(?:only|sir|bas|sirf|सिर्फ|बस)\s+)*(?:₹|rs\.?\s*)?\s*\d+(?:\.\d+)?(?:\s*(?:-|–|to|se)\s*\d+(?:\.\d+)?)?\s*(?:(?:rupees?|rs\.?|rupaye|रुपये|रुपया|₹|hai|है|sir)\s*)*[.!🙏]*$/iu.test(reply.trim())
}
