export function billRetrievalGuard({ buyerText, reply, history = [], imageUrl, english = false }) {
  if (imageUrl || String(reply || '').trim() !== '[DEFER]') return null
  const ask = String(buyerText || '').normalize('NFKC').trim()
  if (ask.length > 160 || /[\[\]\n]/.test(ask)) return null
  const text = ask.replace(/^(?:(?:hello|hi|sir|bhaiya|bhai|please|kindly)[,! .]+)+/i, '')
    .replace(/[?!.\s]+$/, '').replace(/\s+/g, ' ').toLowerCase()
  const hindi = /^(?:(?:mai|main|mein|mera|meri|apna|apni|mujhe) )?(?:bill|invoice) (?:kaha|kahan|kidhar) (?:se )?(?:nikalu|nikaalu|nikalun|nikaalun|milega|milegi|milegaa|dekhu|dekhun|download karu|download karun)$/
  const englishAsk = /^(?:where (?:can|do|should) i (?:find|get|download|see)|how (?:can|do|should) i (?:get|download|see)) (?:my |the |a |an )?(?:bill|invoice)$/
  if (!hindi.test(text) && !englishAsk.test(text)) return null
  if (history.slice(-6).some(row => /https?:\/\/(?:www\.)?sale91\.com\/login\b/i.test(row.aiReply || ''))) return null
  return english
    ? 'Log in to see and download your bills sir 👉 https://sale91.com/login'
    : 'Login karte hi aapke saare bills sync ho jayenge sir 👉 https://sale91.com/login'
}

export function billLoginIdentityGuard({ reply, imageUrl }) {
  const text = String(reply || '')
  if (imageUrl || text.length > 600 || /\[(?:DEFER|SKIP)\]|["“”]|\b(?:ledger|refund|otp|password|not|never|cannot|can't|don't)\b/i.test(text)) return null
  if (!/\b(?:bills?|invoices?)\b/i.test(text)) return null
  const links = text.match(/https?:\/\/[^\s<>]+/gi) || []
  if (links.length !== 1 || !/^https:\/\/sale91\.com\/login\/?$/i.test(links[0])) return null
  const wrongIdentity = /\b(log[ -]?in|sign[ -]?in)\s+(?:with|using)\s+(?:(?:the|your)\s+)?(?:same|registered)\s+(?:(?:mobile|phone|whatsapp)\s+)?number\b/gi
  const corrected = text.replace(wrongIdentity, '$1 with the email address you used when ordering')
  return corrected === text ? null : corrected
}
