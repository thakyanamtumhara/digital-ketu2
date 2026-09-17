export function isNearestMetroQuestion(text) {
  const question = String(text || '').normalize('NFKC').trim()
  return /^(?:(?:sir|bro|please|pls|plz)[,\s]+)?(?:(?:which|what)\s+(?:is\s+)?(?:the\s+)?)?(?:near|nearby|nearest|closest)\s+metro(?:\s+station)?(?:\s+(?:sir|bro|please|pls|plz))?[?.!]*$/i.test(question)
    || /^(?:(?:sir|bro|please|pls|plz)[,\s]+)?which\s+metro(?:\s+station)?\s+is\s+(?:the\s+)?(?:nearest|closest)(?:\s+(?:sir|bro|please|pls|plz))?[?.!]*$/i.test(question)
}
