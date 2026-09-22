const FOUR_DISCOUNT_RE = /(?:₹\s*4\b|\b4\s*(?:rs\.?|rupees?|rupaye|taka)\b)[^.\n]{0,35}\bdiscount\b|\bdiscount\b[^.\n]{0,25}(?:₹\s*4\b|\b4\s*(?:rs\.?|rupees?|rupaye|taka)\b)/i
const TROUBLE_RE = /\b(?:no\s+discount|(?:not|isn't|isnt|doesn't|doesnt)\s+(?:\w+\s+){0,2}(?:apply\w*|get\w*|show\w*|work\w*)|(?:nahi|nhi|nahin)\s+(?:\w+\s+){0,2}(?:mil\w*|aa\w*|apply|lag\w*|ho\w*))\b/i
const OTHER_TASK_RE = /\b(?:coupon|code|refund\w*|return\w*|replace\w*|defect\w*|damag\w*|complaint\w*|dispatch\w*|deliver\w*|courier|tracking|parcel|paid|payment|gst|invoice|bill|stock|restock\w*|available|availability|fabric|print\w*|embroid\w*|shrink\w*|address|location|hours?|call|video\s+(?:already|not|nahi|nhi)|already\s+(?:saw|seen|watched)|still\s+(?:not|no))\b/i
const MECHANICS_RE = /\b(?:multiple[s]?\s+of\s+10|10\s*(?:ke\s*)?multiple[s]?|(?:per|each|har)\s+size[^.\n]{0,35}\b10\b|\b10\b[^.\n]{0,35}(?:per|each|har)\s+size)/i
const MECHANICS_WORDS = new Set('discount discounts the a is are will only applies applied apply applying from on in of website multiples multiple per each every size sizes sir madam and so or to get gets for you your order orders buy purchase keep quantities quantity pieces pcs pc as then not ten twenty thirty rupee rupees rs taka har ke ka ki mein me rakho rakhiye karoge karo karke tabhi to lagega lagta hai hota ho jayega jaayega milega milta nahi nhi ye liye lijiye ya'.split(' '))

export function discountTroubleVideoGuard({ buyerText, reply, imageUrl, history = [], english = false }) {
  const buyer = String(buyerText || '')
  if (!reply || imageUrl || /\[DEFER\]/.test(reply)) return null
  if (history.slice(-6).some(row => /dnFWXQW5yqk/.test(row.aiReply || ''))) return null
  if (!FOUR_DISCOUNT_RE.test(buyer) || !TROUBLE_RE.test(buyer)) return null
  if (OTHER_TASK_RE.test(buyer + '\n' + reply) || !MECHANICS_RE.test(reply)) return null
  const words = reply.replace(/https?:\/\/\S+/gi, '').toLowerCase().match(/[\p{L}]+/gu) || []
  if (!words.length || words.some(word => !MECHANICS_WORDS.has(word))) return null
  return english
    ? 'Please watch this video sir 👉 https://youtube.com/shorts/dnFWXQW5yqk'
    : 'Ye video dekh lijiye sir 👉 https://youtube.com/shorts/dnFWXQW5yqk'
}
