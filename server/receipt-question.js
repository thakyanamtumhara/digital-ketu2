export function isRecipientReceiptQuestion(text) {
  const value = String(text || '').normalize('NFKC').trim().replace(/\s+/g, ' ')
  const item = '(?:(?:the|my|mera|meri) )?(?:parcel|package|t[- ]?shirts?|tees?|maal|samaan)'
  const received = 'mil(?:a|i|e| gaya| gayi| gaye)(?: (?:hai|hain))?'
  const recipient = '(?:aa?p ?ko|tumko|aap logon ko)'
  const polite = '(?:(?:sir|bhai|bhaiya)[, ]+)?'
  const end = '(?: (?:sir|bhai|bhaiya|kya))?[?？؟.!]*'
  return new RegExp(`^${polite}(?:${item} ${received} ${recipient}|${recipient} ${item} ${received}|(?:did|have) you (?:receive|received|get|got) ${item}(?: back)?|has ${item} reached you)${end}$`, 'i').test(value)
}
