const BUYER_INTENT = /[?？؟]|\d+\s*(?:gsm|pcs?|pieces?)\b|\b(?:prices?|rates?|gsm|chahiye|chaiye|orders?|stock|sizes?|colou?rs?|samples?|bulk|hai|milega|kitna|kitne|send|bhej|buy|buying|purchase|need|want|require|interested|enquiry|inquiry|refund|return|complaint|payment|paid|invoice|delivery|dispatch|tracking|partnership|supplier|manufactur(?:e|er|ing)|black|white|navy|maroon|xxl|xl)\b|चाहिए|मिलेगा|कितन|कीमत|भेज|ऑर्डर/i
const APPAREL = /\b(?:t[ -]?shirts?|tees?|hoodies?|polos?|uniforms?|sports\s*wear|festival\s*(?:and|&)\s*event\s*wear|custom\s*(?:clothing|designs?|prints?))\b/i

export function isPrintCatalogueGreeting(text, messages = []) {
  if (!messages.length || messages.some(m => m?.messageType !== 'text' || m.hasMedia || m.mediaUrl)) return false
  const value = String(text || '').trim().replace(/[’‘]/g, "'")
  if (value.length > 900) return false
  const match = value.match(/^Hey!\s*👋\s*Welcome to ([\p{Script=Latin}& .'-]{1,60})\s*💛\s*We print your mood, memories & story\s*✨\s*Clothing Catalog\s*👇\s*https:\/\/tinyurl\.com\/[a-z0-9-]{1,60}\s*Diary Collection\s*👇\s*https:\/\/tinyurl\.com\/[a-z0-9-]{1,60}\s*Place your order here\s*👇\s*https:\/\/forms\.gle\/[a-z0-9]{1,60}\s*Just send your idea\s*—\s*we'll create it for you\s*🚀$/iu)
  return !!match && !BUYER_INTENT.test(match[1])
}

export function isSocialLinksGreeting(text, messages = []) {
  if (!messages.length || messages.some(m => m?.messageType !== 'text' || m.hasMedia || m.mediaUrl)) return false
  const value = String(text || '').trim()
  if (value.length > 900) return false
  return /^Ty for contacting for more info our socials\s+Insta- https:\/\/www\.instagram\.com\/[a-z0-9_.]{1,80}\/?\s+Youtube- https:\/\/www\.youtube\.com\/results\?search_query=[a-z0-9_.-]{1,80}\s+Google- https:\/\/maps\.app\.goo\.gl\/[a-z0-9]{1,80}\s+Website- https:\/\/[a-z0-9-]{1,80}\.my\.canva\.site\/?$/i.test(value)
}

export function isProjectServiceGreeting(text, messages = []) {
  if (!messages.length || messages.some(m => m?.messageType !== 'text' || m.hasMedia || m.mediaUrl)) return false
  const value = String(text || '').trim().replace(/[’‘]/g, "'")
  if (value.length > 700) return false
  const match = value.match(/^(?:👋\s*)?Hello\s*&\s*Welcome\s+to\s+([\p{Script=Latin}& .'-]{1,80})!\s*Thank\s+you\s+for\s+connecting\s+with\s+us\.\s*[\p{S}\s]*We're\s+happy\s+to\s+assist\s+you\s+with\s+your\s+project\.\s*Please\s+share\s+your\s+requirement,\s*size\s*&\s*location,\s*and\s+our\s+team\s+will\s+get\s+back\s+to\s+you\s+with\s+the\s+right\s+solution\.\s*Regards,\s*([\p{Script=Latin} .'-]{1,60})\r?\n\s*([\p{Script=Latin}& .'-]{1,80})\r?\n\s*Building\s+Smart\.\s*Building\s+Better\.\s*$/iu)
  return !!match && match[1].trim().toLowerCase() === match[3].trim().toLowerCase() && !BUYER_INTENT.test(match[1] + ' ' + match[2]) && !APPAREL.test(match[1] + ' ' + match[2])
}

export function isPrintServiceGreeting(text, messages = []) {
  if (!messages.length || messages.some(m => m?.messageType !== 'text' || m.hasMedia || m.mediaUrl)) return false
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (value.length > 700) return false
  const match = value.match(/^(?:(?:thank\s+you|thanks)[.!\s]*)?(?:hello[.!\s]*)?thank\s+you\s+for\s+contacting\s+([\p{Script=Latin}\p{N}& .'’-]{1,80}?)[\s\p{P}\p{S}]*we\s+speciali[sz]e\s+in\s+custom\s+t[ -]?shirt\s+printing[.!\s]+please\s+share\s+your\s+design,\s*quantity,\s*and\s+t[ -]?shirt\s+size[.!\s]+our\s+team\s+will\s+reply\s+shortly[.!"”\s]*$/iu)
  return !!match && !BUYER_INTENT.test(match[1])
}

export function isStoreReceiptGreeting(text, messages = []) {
  if (!messages.length || messages.some(m => m?.messageType !== 'text' || m.hasMedia || m.mediaUrl)) return false
  const value = String(text || '').trim().replace(/[’‘]/g, "'")
  if (value.length > 700) return false
  const match = value.match(/^(?:(?:hi|hey|hello)\b[\s\p{P}\p{S}]*)?thank\s+you\s+for\s+(?:messaging|contacting)\s+([\p{L}\p{N}& -]{1,80})[.!\s]+we(?:'ve|\s+have)\s+received\s+your\s+message\s+and\s+(?:we\s+will|will|we'll)\s+get\s+back\s+to\s+you\s+as\s+soon\s+as\s+possible[.!\s]*feel\s+free\s+to\s+send\s+us\s+a\s+screenshot,\s*product\s+name,\s*or\s+size\s+you(?:'re|\s+are)\s+looking\s+for[.!\s\p{S}]*$/iu)
  return !!match && !BUYER_INTENT.test(match[1])
}

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
