export function isOrderHowFollowup(text, recentReplies, now = Date.now()) {
  const question = String(text || '').normalize('NFKC').trim()
  if (!/^(?:(?:ok(?:ay)?|acha|achha)\s+)?(?:sir\s+)?(?:kaise|kese|kaise\s+kare|how)(?:\s+sir)?\s*[?!.]*$/i.test(question)) return false
  const last = recentReplies?.[0]
  const age = now - Date.parse(last?.createdAt)
  const reply = String(last?.aiReply || '')
  if (!Number.isFinite(age) || age < 0 || age > 2 * 60 * 60 * 1000) return false
  if (/\[DEFER\]|ketu will reply shortly|\b(?:cancel|refund|complaint|failed|dispatch|tracking|parcel|payment|paid|bank|upi)\b/i.test(reply + ' ' + (last?.buyerMessage || ''))) return false
  return /\border\b/i.test(reply)
    && ( /\b(?:website|online)\b/i.test(reply)
      || /\border\s+ho\s+jayega\b/i.test(reply)
      || /\b(?:can|may)\s+(?:also\s+)?order\b/i.test(reply))
}

export function isOrderLinkFollowup(text, recentReplies, now = Date.now()) {
  const question = String(text || '').normalize('NFKC').replace(/[,.!?]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!/^(?:(?:yes|yea|yeah|ok|okay)\s+)?i\s+(?:will|want\s+to|would\s+like\s+to)\s+(?:order|buy)\s+(?:please\s+)?(?:give|send|share)\s+(?:me\s+)?(?:(?:the|a)\s+)?(?:(?:website|ordering)\s+)?link(?:\s+(?:please|sir))?$/i.test(question)) return false
  const last = recentReplies?.[0]
  const age = now - Date.parse(last?.createdAt)
  const reply = String(last?.aiReply || '')
  if (!Number.isFinite(age) || age < 0 || age > 2 * 60 * 60 * 1000) return false
  if (/\[DEFER\]|ketu will reply shortly|\b(?:cancel|refund|complaint|failed|dispatch|tracking|parcel|payment|paid|bank|upi)\b/i.test(reply + ' ' + (last?.buyerMessage || ''))) return false
  return /https:\/\/(?:www\.)?(?:sale91\.com|bulkplaintshirt\.com)(?:[/?#]|$)/i.test(reply)
}
