const TRUE_BIO = /\btrue[\s-]*bio(?:[\s-]*wash)?\b/i
const OTHER_PRODUCT = /\b(?:oversiz\w*|over\s*size|os\s*180|kids?|children|non[\s-]*bio|polo|hoodie|sweatshirt|sublimation|shorts?|boxy|acid\s*wash|drop\s*shoulder)\b/i
const SPECIFIC_BLUE = /\b(?:navy|royal|sky|powder|light|dark|turquoise|teal|aqua|cobalt|indigo|electric|baby)\b/i
const EXACT_BLUE = /\b(?:exact(?:ly)?|same|only(?:\s+plain)?)\s+blue\b|\bblue\s+(?:only|exact(?:\s+shade)?)\b|\[(?:image|photo|picture)\]|\b(?:this|that|yeh?|is|iss|same|exact)\s+(?:photo|image|pic|picture|screenshot)\b|\b(?:photo|image|pic|picture|screenshot)\b[^.!?\n]{0,30}\b(?:match|same|exact|jaisa|wala|wali)\b|\b(?:match|same|exact|jaisa)\b[^.!?\n]{0,30}\b(?:photo|image|pic|picture|screenshot)\b/i
const BLUE_NAMES = new Set(['navy', 'royal blue', 'sky', 'blue'])
const TEMPORARY_OR_SIZE = /\b(?:stock|currently|right\s+now|at\s+present|abhi|filhaal|today|aaj|sold|left|khatam|size|small|medium|large|xxs|xs|s|m|l|xl|xxl|xxxl|36|38|40|42|44|46)\b/i
const TEMPORARY = /\bout\s+of\s+stock\b|\bstock\s+(?:mein\s+)?(?:nahi|nhi|khatam)\b|\b(?:currently|right\s+now|at\s+present|abhi|filhaal|today|aaj|sold\s*out|khatam)\b/i
const STOCK_QUESTION = /\b(?:stock|restock\w*|refill\w*|currently|now|at\s+present|abhi|filhaal|today|aaj)\b/i
const EXCLUDED_ENTITY = /\b(?:not|no|except|excluding|exclude|without|other\s+than|anything\s+but|(?:do\s+not|don't|dont)\s+(?:want|need))\s+(?:(?:the|any|a|an)\s+)?(?:true[\s-]*bio(?:[\s-]*wash)?|regular[\s-]*fit|blue)\b|\b(?:true[\s-]*bio(?:[\s-]*wash)?|regular[\s-]*fit|blue)\s+(?:(?:nahi|nhi)\s+(?:chahiye|chaiye|chahie|dena|bhejna)|mat\s+(?:dena|bhejna))\b/i
const DENIAL = /\b(?:nahi|nhi|not|no|isn't|isnt|don't|dont|doesn't|doesnt|unavailable)\b/i
const OPENING_WORDS = new Set("180 gsm regular fit true bio biowash wash t shirt shirts tshirt tshirts tee tees mein me mai blue colour color colours colors nahi nhi hai hain h sir bhai ji no not is are isn't isnt don't dont doesn't doesnt we have has make made offered offer carry carries available unavailable in for the a an this that banta bante banate milta milti".split(' '))
const plain = value => String(value || '').replace(/https?:\/\/\S+/gi, ' ')
const hasOtherGsm = text => [...String(text || '').matchAll(/\b(\d+(?:\.\d+)?)\s*gsm\b/gi)].some(match => Number(match[1]) !== 180)

function explicitScope(text) {
  if (OTHER_PRODUCT.test(text) || hasOtherGsm(text) || EXCLUDED_ENTITY.test(text)) return false
  const withoutTrueBio = text.replace(/\btrue[\s-]*bio(?:[\s-]*wash)?\b/gi, '')
  if (/\bbio(?:[\s-]*wash)?\b/i.test(withoutTrueBio)) return false
  return TRUE_BIO.test(text) || /\b180\s*gsm\b/i.test(text) && /\bregular[\s-]*fit\b/i.test(text)
}

function requestSource({ products = [], buyerText, history = [], now = Date.now() }) {
  const text = plain(buyerText).trim()
  if (!/\bblue\b/i.test(text) || SPECIFIC_BLUE.test(text) || EXACT_BLUE.test(text) || OTHER_PRODUCT.test(text) || hasOtherGsm(text) || EXCLUDED_ENTITY.test(text)) return null
  if (/\b(?:tracking|parcel|refund|return|complaint|wrong|received|payment|invoice|bill|logo|printing|print)\b/i.test(text)) return null
  const withoutTrueBio = text.replace(/\btrue[\s-]*bio(?:[\s-]*wash)?\b/gi, '')
  if (/\bbio(?:[\s-]*wash)?\b/i.test(withoutTrueBio)) return null
  let inheritedStockQuestion = false
  if (!explicitScope(text)) {
    const previous = Array.isArray(history) ? history.at(-1) : null
    const age = now - Date.parse(previous?.createdAt)
    if (!previous || previous.deferReason === 'manual_reply' || !Number.isFinite(age) || age < 0 || age > 6 * 3600000 || !explicitScope(plain(previous.buyerMessage)) || SPECIFIC_BLUE.test(plain(previous.buyerMessage)) || EXACT_BLUE.test(plain(previous.buyerMessage))) return null
    if (/\b(?:order|tracking|parcel|refund|return|complaint|payment|invoice|bill|logo|printing|print)\b/i.test(text)) return null
    inheritedStockQuestion = STOCK_QUESTION.test(plain(previous.buyerMessage))
  }
  const matching = products.filter(product => product?.slug === 'true-biowash-round-neck')
  if (matching.length !== 1) return null
  const product = matching[0]
  if (product.gsm !== 180 || product.fit !== 'regular' || !Array.isArray(product.colors) || !product.colors.length || product.colors.some(colour => typeof colour !== 'string' || !colour.trim())) return null
  const shades = product.colors.filter(colour => BLUE_NAMES.has(colour.trim().toLowerCase()))
    .map(colour => colour.trim()).filter((colour, index, all) => all.findIndex(value => value.toLowerCase() === colour.toLowerCase()) === index)
  return shades.length ? { shades, inheritedStockQuestion } : null
}

export function regularFitBlueHint(context) {
  const source = requestSource(context)
  if (!source) return null
  return `REGULAR-FIT BLUE REQUEST: the current catalogue identifies True Bio as 180gsm regular fit. Its offered blue-family shades are ${source.shades.join(' / ')}. The buyer's generic "blue" includes these shades; do not deny blue because there is no colour named exactly Blue. Lead with these True Bio options, then answer the buyer's price/size/quantity question from the current catalogue. These are catalogue colours, NOT proof of live stock or availability in the requested size. Do not infer an order quantity from a stray number.`
}

export function regularFitBlueGuard({ reply, english = false, ...context }) {
  const source = requestSource(context)
  const output = String(reply || '')
  if (!source || source.inheritedStockQuestion || STOCK_QUESTION.test(plain(context.buyerText)) || !output.trim() || /\[(?:DEFER|SKIP)\]/i.test(output) || TEMPORARY.test(plain(output))) return null
  const separator = /\s*(?:[—–;]|\n+|[.!?](?=\s|$))\s*/g
  const split = separator.exec(output)
  const opening = (split ? output.slice(0, split.index) : output).trim()
  if (opening.length > 170 || !/\bblue\b/i.test(opening) || SPECIFIC_BLUE.test(opening) || !DENIAL.test(opening) || TEMPORARY_OR_SIZE.test(opening) || !explicitScope(opening)) return null
  const words = opening.toLowerCase().replace(/180\s*gsm/g, '180 gsm').replace(/[^a-z0-9']+/g, ' ').trim().split(/\s+/)
  if (words.some(word => !OPENING_WORDS.has(word))) return null
  let tail = split ? output.slice(split.index + split[0].length).trim() : ''
  const shade = '(?:Royal\\s+Blue|Navy|Sky|Blue)'
  const listing = new RegExp('^True[\\s-]*Bio(?:[\\s-]*wash)?\\s+(?:mein|me|mai)\\s+' + shade + '(?:\\s*(?:,|/|aur|and)\\s*' + shade + ')*\\s+(?:hai|hain|h)\\b(?:\\s*[,;.]\\s*|\\s*$)', 'i')
  tail = tail.replace(listing, '')
  const shades = source.shades.join(', ')
  const answer = english
    ? `Yes sir, True Bio is 180gsm regular fit and comes in ${shades}.`
    : `Haan sir, True Bio 180gsm regular fit mein ${shades} aate hain.`
  return answer + (tail ? ' ' + tail : '')
}
