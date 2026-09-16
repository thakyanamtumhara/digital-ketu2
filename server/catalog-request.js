export function catalogRequestHasTimingQuestion(text) {
  const value = String(text || '').replace(/https?:\/\/\S+/gi, ' ')
  return /\bkit(?:a)?n[ae]\s*(?:din|days?|time|samay)\b|\bhow\s+(?:many\s+days|long)\b|\b(?:when|kab)\b[^.!?\n]{0,40}\b(?:arriv\w*|deliver\w*|reach\w*|dispatch\w*|aayeg\w*|aaeg\w*|ayeg\w*|mileg\w*|pahunch\w*)\b|\b(?:delivery|shipping|dispatch)\s+(?:time|date|kab)\b|कितने?\s*(?:दिन|समय)|कब[^.!?\n]{0,30}(?:आएगा|आयेगा|मिलेगा|पहुंचेगा|पहुँचेगा)/i.test(value)
}
