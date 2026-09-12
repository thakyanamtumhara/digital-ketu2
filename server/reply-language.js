const HINDI_WORDS = /\b(hai|hain|nahi|nhi|karo|kariye|karke|lijiye|dijiye|kijiye|bhejo|bhejiye|bataiye|batao|batana|aap|aapka|aapke|apka|kya|kyu|kyon|mein|milega|milegi|chahiye|wala|wale|wali|bhaiya|bhai|abhi|sirf|hoga|hogi|karna|karni|krna|dedo|lelo|dekhiye|kitna|kitne|kitni|kaise|kaha|kahan|jaldi|maal|jayega|jayegi|karwa|karva|bhej|laga|lag|raha|rahi|gaya|gayi|mujhe|mujha|mera|meri|mere|apna|apni|apne|kar|kr|lo|pe|ka|ki|ke|ko|aur|par|baat|hu|hun|hum|haan|thik)\b/i
const ENGLISH_WORDS = /\b(i|we|my|our|us|the|is|are|do|does|can|could|will|would|please|want|need|have|has|you|your|what|when|where|how|much|many|price|order|delivery|available|stock|send|share|tell|get|contact|details|number|about|this|that|with|and|for|from|there|any)\b/gi
const withoutLinks = text => String(text || '').replace(/https?:\/\/\S+/gi, ' ')
const nonLatinLetters = text => /\p{L}/u.test(text.replace(/\p{Script=Latin}/gu, ''))

export function containsHindi(text) {
  const words = withoutLinks(text).replace(/\bTSHIRT WALA GODAM\b/gi, '')
  return HINDI_WORDS.test(words) || /[ऀ-ॿ]/.test(words)
    || /\b(?:XXS|XS|S|M|L|XL|XXL|XXXL|\d{2})\s+se\s+(?:XXS|XS|S|M|L|XL|XXL|XXXL|\d{2})\b/i.test(words)
}

function explicitLanguage(text) {
  const words = withoutLinks(text)
  if (/\b(in english|english (please|pls|plz)|english me(?:in)?\s*(bolo|batao|reply|likho)?|(please|pls|plz) english|reply in english|only english)\b/i.test(words)) return 'english'
  if (/\b(hindi me(?:in)?\s*(bolo|batao|baat|reply|likho)|in hindi|hindi please|reply in hindi)\b/i.test(words)) return 'hindi'
  return null
}

function detectedLanguage(text) {
  const words = withoutLinks(text)
  if (containsHindi(words) || nonLatinLetters(words)) return 'other'
  return (words.match(ENGLISH_WORDS) || []).length >= 2 ? 'english' : null
}

export function buyerUsesEnglish({ buyerText, history = [], preferredLanguage = null }) {
  const buyerHistory = (Array.isArray(history) ? history : []).filter(row => row && row.deferReason !== 'manual_reply')
  const explicit = explicitLanguage(buyerText) || preferredLanguage
    || buyerHistory.slice().reverse().map(row => explicitLanguage(row.buyerMessage)).find(Boolean)
  if (explicit) return String(explicit).toLowerCase() === 'english'
  const current = detectedLanguage(buyerText)
  if (current) return current === 'english'
  for (const row of buyerHistory.slice().reverse()) {
    const language = detectedLanguage(row.buyerMessage)
    if (language) return language === 'english'
  }
  return /^\s*(?:location|address|contact)(?:\s+(?:sir|please|pls|plz))?\s*[?.!]*\s*$/i.test(buyerText || '')
}

function protectedValues(text) {
  const links = (String(text).match(/https?:\/\/[^\s<>"']+/gi) || []).map(link => link.replace(/[),.!?;:]+$/, '')).sort()
  const numbers = (withoutLinks(text).match(/\d+(?:[.,]\d+)*/g) || []).sort()
  const actions = (String(text).match(/\[(?:DEFER|SKIP)\]/g) || []).sort()
  const names = (String(text).match(/\bTSHIRT WALA GODAM\b/gi) || []).map(() => 'TSHIRT WALA GODAM')
  return JSON.stringify({ links, numbers, actions, names })
}

export async function repairEnglishReply({ anthropic, reply, ...context }) {
  const result = { reply, costUsd: 0, attempted: false, changed: false }
  if (!buyerUsesEnglish(context) || !containsHindi(reply)) return result
  result.attempted = true
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300,
      messages: [{ role: 'user', content: `Rewrite this WhatsApp reply in natural ENGLISH ONLY — no Hindi/Hinglish words (hai, nahi, kar lijiye, milega, etc.). Same meaning, same terse length. Keep "sir", links, emojis and ₹ prices unchanged. Keep the business name TSHIRT WALA GODAM unchanged; it is a name, not Hindi prose. Output ONLY the rewritten message.\n\n${reply}` }],
    })
    result.costUsd = ((response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0) * 5) / 1_000_000
    const rewritten = (response.content || []).filter(part => part.type === 'text').map(part => part.text).join('').trim()
    if (rewritten && !containsHindi(rewritten) && !nonLatinLetters(withoutLinks(rewritten))
        && rewritten.length <= String(reply).length * 2 + 80 && protectedValues(rewritten) === protectedValues(reply)) {
      result.reply = rewritten
      result.changed = true
    }
  } catch {
    result.failed = true
  }
  return result
}
