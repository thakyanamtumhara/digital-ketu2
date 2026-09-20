import { detectColoursAndSizes, resolveTimedFactProduct, PRODUCT_NAMED_RE } from './stock-lookup.js'

const CHOICE_WORDS = new Set('which what kaun sa kaunsa konsa product sir bhai ji oversize oversized gsm 210 240 acid wash acidwash ya or'.split(' '))
const STOCK_WORDS = new Set('hi hie hii hello sir bhai ji please pls stock restock refill black white navy red grey gray off offwhite brown beige biege lavender maroon s m l xl xxl small medium large kab kb tak tk when will be back available in update updat hoga ayega aayega hai hain'.split(' '))
const wordsOf = text => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)

export function resolvedStockChoice({ buyerText, history = [], imageUrl, now = Date.now() }) {
  if (imageUrl) return null
  const selected = String(buyerText || '').trim().match(/^(?:oversized?\s+)?(210|240)\s*gsm(?:\s+sir)?[.!]?$/i)
  if (!selected) return null
  const previous = Array.isArray(history) ? history.at(-1) : null
  if (!previous || previous.status !== 'REPLIED' || previous.deferReason === 'manual_reply' || previous.isMedia) return null
  const age = now - Date.parse(previous.createdAt)
  if (!Number.isFinite(age) || age < 0 || age > 2 * 3600000) return null
  const question = String(previous.aiReply || '').trim()
  if (/[^a-z0-9\s.,?!—–-]/i.test(question)) return null
  if (question.length > 160 || !/\b(?:which|what|kaun\s*sa|kaunsa|konsa)\b/i.test(question) || !/\boversized?\b/i.test(question)) return null
  if (!new RegExp(`\\b${selected[1]}\\b`).test(question) || wordsOf(question).some(word => !CHOICE_WORDS.has(word))) return null
  const request = String(previous.buyerMessage || '').trim()
  if (/[^a-z0-9\s.,?!—–-]/i.test(request)) return null
  if (!request || request.length > 120 || PRODUCT_NAMED_RE.test(request) || !/\b(?:stock|restock|refill|kab|kb|when|update|updat)\b/i.test(request)) return null
  if (wordsOf(request).some(word => !STOCK_WORDS.has(word))) return null
  const normalized = request.replace(/\bsmall\b/gi, 'S').replace(/\bmedium\b/gi, 'M').replace(/\blarge\b/gi, 'L')
  const { colours, sizes } = detectColoursAndSizes(normalized)
  if (colours.length !== 1 || sizes.length !== 1 || !['S', 'M', 'L', 'XL', 'XXL'].includes(sizes[0])) return null
  return `Oversize ${selected[1]}gsm ${normalized}`
}

export function unavailableStockChoice({ request, snapshot, now = Date.now() }) {
  if (!request || !snapshot || !Number.isFinite(snapshot.fetchedAt)) return false
  const age = now - snapshot.fetchedAt
  if (age < 0 || age > 5 * 60000) return false
  const product = resolveTimedFactProduct(request)
  const { colours, sizes } = detectColoursAndSizes(request)
  if (!['Oversize 210gsm', 'Oversize 240gsm'].includes(product) || colours.length !== 1 || sizes.length !== 1) return false
  const offered = snapshot.inStock?.[product]?.[colours[0]]
  const out = snapshot.oos?.[product]?.[colours[0]]
  return !!offered && typeof out === 'string' && out.split(',').map(size => size.trim()).includes(sizes[0])
}
