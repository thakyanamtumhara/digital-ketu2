export function catalogRequestHasTimingQuestion(text) {
  const value = String(text || '').replace(/https?:\/\/\S+/gi, ' ')
  return /\bkit(?:a)?n[ae]\s*(?:din|days?|time|samay)\b|\bhow\s+(?:many\s+days|long)\b|\b(?:when|kab)\b[^.!?\n]{0,40}\b(?:arriv\w*|deliver\w*|reach\w*|dispatch\w*|aayeg\w*|aaeg\w*|ayeg\w*|mileg\w*|pahunch\w*)\b|\b(?:delivery|shipping|dispatch)\s+(?:time|date|kab)\b|कितने?\s*(?:दिन|समय)|कब[^.!?\n]{0,30}(?:आएगा|आयेगा|मिलेगा|पहुंचेगा|पहुँचेगा)/i.test(value)
}

export function catalogRequestHasSampleQuestion(text) {
  const value = String(text || '').replace(/https?:\/\/\S+/gi, ' ')
  return /\bsamples?\s+(?:(?:order\s+)?(?:mil\s*sakt[aei]|mile?g[aei]|chahiye|chahie|chaiye|available|possible)|(?:ka|ki|ke)\s+(?:rate|price|cost)|(?:kaise|kese)\s+(?:le|mang|order))\b|\b(?:can\s+(?:i|we)\s+(?:get|buy|order)|(?:i|we)\s+(?:want|need)|do\s+you\s+(?:sell|offer|have))\s+(?:(?:a|one|some|the)\s+)?samples?\b|\b(?:how\s+(?:can|do)\s+(?:i|we)|how\s+to)\s+(?:get|buy|order)\s+samples?\b/i.test(value)
}
