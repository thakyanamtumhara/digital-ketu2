export function isPrinterFulfilmentFollowup(text, recentReplies, now = Date.now()) {
  const question = String(text || '').normalize('NFKC').trim()
  if (!/^(?:will|can|could|does)\s+(?:he|they|the\s+printer)\s+print(?:\s+(?:it|them|these|those))?\s+(?:and|&)\s+(?:send|ship|courier)(?:\s+(?:it|them|these|those))?(?:\s+directly)?\s+to\s+(?:me|us)\s*(?:sir|bro)?[?.!]*$/i.test(question)) return false
  const last = recentReplies?.[0]
  const age = now - Date.parse(last?.createdAt)
  const reply = String(last?.aiReply || '')
  return Number.isFinite(age) && age >= 0 && age <= 2 * 60 * 60 * 1000
    && /\bprinter\b/i.test(reply)
    && /\b(?:talk|contact|baat)\b/i.test(reply)
    && /https:\/\/wa\.me\/\d{10,15}\b/i.test(reply)
    && !/\[DEFER\]|ketu will reply shortly/i.test(reply)
}

export function isPrinterContactFollowup(text, recentReplies, now = Date.now()) {
  const question = String(text || '').normalize('NFKC').trim()
  if (!/^(?:(?:yeh?|yah|woh?|ye)\s+(?:number\s+kis\s*ka|kis\s*ka\s+(?:number|no\.?))\s*(?:h|hai)?|(?:whose|who['’]?s)\s+(?:phone\s+)?number\s+is\s+(?:this|that)|(?:ये|यह|वो|वह)\s+(?:किसका\s+(?:नंबर|नम्बर)|(?:नंबर|नम्बर)\s+किसका)\s*है)\s*(?:sir|bhai|जी)?[?？؟.!]*$/iu.test(question)) return false
  const last = recentReplies?.[0]
  const age = now - new Date(last?.createdAt).getTime()
  const reply = String(last?.aiReply || '')
  return Number.isFinite(age) && age >= 0 && age <= 2 * 60 * 60 * 1000
    && /\bprinter\b/i.test(reply)
    && /\b(?:talk|contact|baat)\b/i.test(reply)
    && (reply.match(/https:\/\/wa\.me\/\d{10,15}\b/gi) || []).length === 1
    && !/\[DEFER\]|ketu will reply shortly/i.test(reply)
}
