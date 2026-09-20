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
