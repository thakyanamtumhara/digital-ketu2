export function isGameEarningsFollowup(text, recentReplies, now = Date.now()) {
  const question = String(text || '').normalize('NFKC').trim()
  if (!/^(?:can|could)\s+(?:we|i)\s+(?:also\s+)?(?:earn(?:\s+(?:money|cash))?|make\s+money)(?:\s+(?:from|by|through|with)\s+(?:playing\s+)?(?:it|that|this|(?:the|this|that)\s+game))?\s*(?:sir|bro)?[?.!]*$/i.test(question)) return false
  const last = recentReplies?.[0]
  const age = now - Date.parse(last?.createdAt)
  return Number.isFinite(age) && age >= 0 && age <= 2 * 60 * 60 * 1000
    && /\bgame\b/i.test(last?.buyerMessage || '')
    && /\bjust\s+for\s+play\s+purpose\b/i.test(last?.aiReply || '')
}
