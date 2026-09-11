import { hasNamedTimingSubject } from './stock-question.js'

const DAY_MS = 86400000
const DAY_DURATION = /(?<![\d.\-–])([0-9०-९]{1,3})(?:\s*(?:[-–]|to|se|से)\s*([0-9०-९]{1,3}))?\s*(days?\b|din\b|दिन)/gi

export function parseTimedFact(content) {
  const m = String(content || '').match(/\[stated (\d{4}-\d{2}-\d{2})\]\s*Buyer asked:\s*"([\s\S]*?)"\s*—\s*Ketu's answer:\s*"([\s\S]*?)"\s*$/)
  return m ? { date: m[1], question: m[2], answer: m[3] } : null
}

export function currentTimedFact(fact, now = Date.now()) {
  if (!fact) return null
  const instant = new Date(now)
  const stated = Date.parse(`${fact.date}T00:00:00Z`)
  if (!Number.isFinite(instant.getTime()) || !Number.isFinite(stated) || new Date(stated).toISOString().slice(0, 10) !== fact.date) return null
  const asOf = new Date(instant.getTime() + 19800000).toISOString().slice(0, 10)
  const elapsedDays = (Date.parse(`${asOf}T00:00:00Z`) - stated) / DAY_MS
  if (elapsedDays < 0) return null
  const matches = [...fact.answer.matchAll(DAY_DURATION)]
  if (!matches.length) return { ...fact, asOf, elapsedDays, adjusted: false }
  if (matches.length !== 1) return null
  const match = matches[0]
  const number = text => Number(text.replace(/[०-९]/g, digit => String(digit.charCodeAt(0) - 0x0966)))
  const min = number(match[1]), max = match[2] ? number(match[2]) : min
  if (min > max || min <= elapsedDays) return null
  const remaining = min === max ? `${min - elapsedDays}` : `${min - elapsedDays}-${max - elapsedDays}`
  const answer = fact.answer.slice(0, match.index) + `${remaining} ${match[3]}` + fact.answer.slice(match.index + match[0].length)
  const qualifier = /\b(?:minimum|min|at least)\b|कम से कम/i.test(fact.answer) ? 'minimum ' : /\b(?:maximum|max|at most|within)\b|ज्यादा से ज्यादा/i.test(fact.answer) ? 'up to ' : ''
  return { ...fact, answer, asOf, elapsedDays, adjusted: true, timingEstimate: `${qualifier}${remaining} days` }
}

export function formatTimedFactsBlock(facts, now = Date.now(), buyerText = '') {
  const lines = (facts || []).map(fact => currentTimedFact(parseTimedFact(typeof fact === 'string' ? fact : fact.content), now)).filter(fact => fact && hasNamedTimingSubject(fact.question)).map(fact =>
    `- [source stated ${fact.date}${fact.adjusted ? `; remaining days calculated for ${fact.asOf} IST — DO NOT subtract days again` : '; interpret relative dates from this source date'}] Buyer asked: "${fact.question}" — ${fact.adjusted ? 'Current timing estimate' : "Ketu's answer"}: "${fact.timingEstimate || fact.answer}"`
  )
  if (!lines.length) return null
  const englishTimingAsk = /\b(?:when\s+will|when\s+.{0,60}\bavailable|how\s+long|i\s+will\s+order|estimated\s+time)\b/i.test(buyerText) && !/[\u0900-\u097f]|\b(?:kab|kitne|hai|hain|hoga|hogi|aayega|aayegi|chahiye|karunga)\b/i.test(buyerText)
  const language = englishTimingAsk ? '\nREPLY LANGUAGE: ENGLISH. This buyer wrote an English timing question or follow-up. Write the ENTIRE reply in English, including any availability or ordering sentence; do not copy Hinglish from historical examples.' : ''
  return `⏰ KETU'S RECENT TIMING ANSWERS (each entry applies ONLY to the product, colour and size named in it. For that exact item it overrides seasonal defaults and the no-date rule. Numeric day estimates below are already adjusted in code for elapsed IST calendar days; relay the remaining estimate in the buyer's language, never restart the original wait or subtract days again. Due, invalid or ambiguous numeric estimates are omitted; they do not establish a new arrival date):\n${lines.join('\n')}${language}`
}
