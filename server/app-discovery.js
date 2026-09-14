export function isAppStoreLookupProblem(text) {
  const value = String(text || '').normalize('NFKC')
  if (!/\b(?:app|play)\s*store\b/i.test(value)) return false
  if (/\b(?:installed\s+(?:it|the\s+app)|found\s+(?:it|the\s+app)|mil\s+gay[ai]|install\s+ho\s+gaya)\b/i.test(value)) return false
  return /\b(?:can(?:not|['’]t)|could(?:\s+not|n['’]t))\s+(?:find|see|locate)\b|\b(?:not|isn['’]t)\s+(?:available|listed|showing|there|on|in)\b|\b(?:nahi|nahin|nhi)\s+(?:(?:bhi|toh?)\s+)?(?:mil|dikh)|\b(?:mil|dikh)\s+(?:(?:hi|bhi)\s+)?(?:nahi|nahin|nhi)\b|नहीं\s*(?:मिल|दिख)/i.test(value)
}

export function appDiscoveryReplyGuard({ buyerText, reply }) {
  if (!isAppStoreLookupProblem(buyerText) || /\[(?:DEFER|SKIP)\]/i.test(reply || '')) return reply
  const text = String(reply || '')
  if (!/\binstall/i.test(text) || !/https:\/\/(?:www\.)?(?:sale91\.com|bulkplaintshirt\.com)(?=[/\s.,!?]|$)/i.test(text)) return reply
  return text
    .replace(/^\s*app\s+(?:nahi|nahin|nhi)\s+hai(?:\s+sir)?(?=\s*[-—–,.!])/i, 'Store par listing nahi hai sir')
    .replace(/^\s*(?:we (?:do not|don['’]t) have an app|there is no app|no app)(?=\s*(?:sir\b|[-—–,.!]))/i, 'There is no store listing')
}
