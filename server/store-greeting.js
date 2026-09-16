const BUYER_INTENT = /[?？؟]|\d+\s*(?:gsm|pcs?|pieces?)\b|\b(?:prices?|rates?|gsm|chahiye|chaiye|orders?|stock|sizes?|colou?rs?|samples?|bulk|hai|milega|kitna|kitne|send|bhej|buy|buying|purchase|need|want|require|interested|enquiry|inquiry|refund|return|complaint|payment|paid|invoice|delivery|dispatch|tracking|partnership|supplier|manufactur(?:e|er|ing)|black|white|navy|maroon|xxl|xl)\b|चाहिए|मिलेगा|कितन|कीमत|भेज|ऑर्डर/i
const APPAREL = /\b(?:t[ -]?shirts?|tees?|hoodies?|polos?|uniforms?|sports\s*wear|festival\s*(?:and|&)\s*event\s*wear|custom\s*(?:clothing|designs?|prints?))\b/i

export function isStoreMenuGreeting(text, messages = []) {
  if (!messages.length || messages.some(m => m?.messageType !== 'text')) return false
  const value = String(text || '').trim()
  if (value.length < 120 || value.length > 1600 || BUYER_INTENT.test(value)) return false
  const understood = value.replace(/ನಿಮ್ಮ requirement ನಮಗೆ message ಮಾಡಿ[.!]?/g, '').replace(/ನಮ್ಮ Catalog check ಮಾಡಿ(?: ಮತ್ತು ನಿಮ್ಮ favourite design ಆಯ್ಕೆ ಮಾಡಿ)?[.!]?/g, '')
  if ([...understood].some(char => /\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char))) return false
  if (!/^(?:(?:hi|hey|hello)\b)?[\s\p{P}\p{S}]*welcome\s+to\b/iu.test(value)) return false
  if (!/\bcatalog(?:ue)?\b/i.test(value) || !/\b(?:check|browse|visit|shop)\b/i.test(value)) return false
  return value.split(/\r?\n/).filter(line => /^[\s\p{P}\p{S}]+\p{L}/u.test(line) && APPAREL.test(line)).length >= 3
}
