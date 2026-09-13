const CHOICE = /^(?:(?:off[ -]?white|black|white|navy|red|grey|gray|beige|biege|brown|maroon|lavender)\s+)?(180|210|240|260)\s*gsm\s+(?:ya|or)\s+(180|210|240|260)\s*gsm(?:\s+sir)?\s*\?$/i
const FOLLOWUP_WORDS = new Set('stock restock refill kab kb tak tk ayega aayega ayegi aayegi aayenge aega aana hoga hogi hai hain h ka ki ke iska iski iske ye yeh wo vo sir bhai ji please pls when will it be back available the come in'.split(' '))
const TIMING_ASK = /\b(?:kab|kb|when|restock|refill)\b/i
const ESTIMATE = /\b\d+\s*(?:[-–]\s*\d+\s*)?(?:days?|din|weeks?|hafte?)\b|\b(?:today|tomorrow|aaj|kal)\b/i
const plain = value => String(value || '').replace(/https?:\/\/\S+/gi, '').replace(/👉/g, '').trim()

export function pendingProductChoiceGuard({ buyerText, history = [], reply, now = Date.now() }) {
  const text = String(buyerText || '').trim()
  const words = text.toLowerCase().replace(/[?!.]+/g, ' ').trim().split(/\s+/)
  if (text.length > 100 || !TIMING_ASK.test(text) || words.some(word => !FOLLOWUP_WORDS.has(word))) return null
  const previous = Array.isArray(history) ? history.at(-1) : null
  if (!previous || previous.status !== 'REPLIED' || previous.deferReason === 'manual_reply') return null
  const age = now - Date.parse(previous.createdAt)
  if (!Number.isFinite(age) || age < 0 || age > 2 * 3600000) return null
  const question = plain(previous.aiReply)
  const choice = question.match(CHOICE)
  if (!choice || choice[1] === choice[2] || /\b\d{3}(?:\s*gsm)?\b/i.test(previous.buyerMessage || '')) return null
  const output = String(reply || '')
  if (output.length > 300 || !ESTIMATE.test(output) || /\[(?:DEFER|SKIP)\]|₹|\brs\.?\b/i.test(output)) return null
  const products = [...output.matchAll(/\b(180|210|240|260)\s*gsm\b/gi)].map(match => match[1])
  if (new Set(products).size > 1 || products.some(product => product !== choice[1] && product !== choice[2])) return null
  return question
}
