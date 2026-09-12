const CLOCK = /(?<![\p{L}\p{N}])(?:[0-9०-९]{1,2}(?:[:.][0-9०-९]{2})?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|do|teen|chaar|char|paanch|panch|chhe|saat|aath|nau|das|gyarah|barah|दो|तीन|चार|पांच|पाँच|छह|सात|आठ|नौ|दस|ग्यारह|बारह)\s*(?:baje|bje|bajey|बजे|[ap]\.?m\.?|o['’]?clock)(?![\p{L}\p{N}])|\b(?:[01]?\d|2[0-3]):[0-5]\d\b/iu
const DELIVERY_CONTEXT = /\b(?:order|parcel|courier|deliver\w*|shipment|bike|porter|receive\w*|reach\w*|arriv\w*)\b|ऑर्डर|पार्सल|डिलीवरी|डिलीवर/iu
const ARRIVAL_PROMISE = /\b(?:will|should|would)\s+(?:(?:be|get|have|it|there|definitely|surely|certainly|probably)\s+){0,4}(?:deliver\w*|reach|arrive|receive\w*)\b|\b(?:deliver\w*|pahunch|pohonch|pohach|pahoch|aa|mil)\b[^.!?\n]{0,35}\b(?:jaay?eg[ai]|jayeg[ai]|jaeg[ai]|denge|dunga|dega|degi)\b|\b(?:pahunch|pohonch|pohach|pahoch)eg[ai]\b|(?:डिलीवर|पहुंच|पहुँच|आ|मिल)[^.!?\n]{0,25}(?:जाएगा|जायेगा|जाएगी|जायेगी|देंगे|दूंगा|दूँगा)|\bdelivery\s+(?:is\s+)?(?:guaranteed|confirmed)\b/iu
const DISCLAIMER = /\b(?:cannot|can't|can’t|unable|won't|won’t|wouldn't|wouldn’t|couldn't|couldn’t|nahi|nahin|nhi)\b|\bnot\s+(?:sure|certain|guaranteed|confirmed|possible|able)\b|नहीं/iu

export function arrivalClockGuard({ buyerText, reply }) {
  const raw = String(reply || '')
  if (!CLOCK.test(raw) || !DELIVERY_CONTEXT.test(`${buyerText || ''} ${raw}`)) return null
  const parts = raw.split(/(?<=[.!?])\s+|\n+/)
  const safe = parts.filter(part => !part.split(/[,;]\s*|\b(?:but|however|lekin|magar)\b/iu)
    .some(clause => CLOCK.test(clause) && ARRIVAL_PROMISE.test(clause) && !DISCLAIMER.test(clause)
      && !/^\s*(?:will|should|would)\b[^]*\?\s*$/i.test(clause)))
  if (safe.length === parts.length) return null
  const answer = safe.join('\n').replace(/\[DEFER\]/g, '').trim()
  return answer ? `${answer}\n[DEFER]` : '[DEFER]'
}
