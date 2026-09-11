import assert from 'node:assert/strict'
import { currentTimedFact, formatTimedFactsBlock } from '../server/timed-facts.js'
import { formatStockBlock } from '../server/stock-lookup.js'

const now = Date.parse('2026-09-11T07:13:31Z')
const fact = (answer, date = '2026-09-07') => ({ date, question: 'Oversize 240gsm Red restock?', answer })
const rows = [
  ['8-9 din mein aa jana chahiye', '4-5 din mein aa jana chahiye'],
  ['8 se 10 din ka wait karo', '4-6 din ka wait karo'],
  ['in 8 to 10 days', 'in 4-6 days'],
  ['8–9 days max', '4-5 days max'],
  ['८ से १० दिन में', '4-6 दिन में'],
  ['8 din mein aayega', '4 din mein aayega'],
  ['minimum 8 days', 'minimum 4 days'],
]
for (const [answer, expected] of rows) assert.equal(currentTimedFact(fact(answer), now).answer, expected)
assert.equal(currentTimedFact(fact('8-9 din', '2026-09-11'), now).answer, '8-9 din')
assert.equal(currentTimedFact(fact('8-9 din', '2026-09-10'), Date.parse('2026-09-10T18:29:59Z')).answer, '8-9 din')
assert.equal(currentTimedFact(fact('8-9 din', '2026-09-10'), Date.parse('2026-09-10T18:30:00Z')).answer, '7-8 din')
assert.equal(currentTimedFact(fact('8-9 din', '2026-08-30'), Date.parse('2026-09-02T06:00:00Z')).answer, '5-6 din')
assert.equal(currentTimedFact(fact('8-9 din', '2024-02-28'), Date.parse('2024-03-01T06:00:00Z')).answer, '6-7 din')
assert.equal(currentTimedFact(fact('30 to 45 days max', '2026-09-06'), now).answer, '25-40 days max')
assert.equal(currentTimedFact(fact('October mein aayega'), now).answer, 'October mein aayega')
assert.equal(currentTimedFact(fact('October mein aayega'), now).adjusted, false)
for (const answer of ['4-8 din', '2-3 days', '0 days', '10-8 days', '8 days red, 12 days white']) assert.equal(currentTimedFact(fact(answer), now), null, answer)
assert.equal(currentTimedFact(fact('8-9 din', '2026-09-12'), now), null)
assert.equal(currentTimedFact(fact('8-9 din', '2026-02-30'), now), null)
assert.equal(currentTimedFact(fact('8-9 din'), NaN), null)
assert.equal(currentTimedFact(null, now), null)

const content = (question, answer, date = '2026-09-07') => ({ content: `[stated ${date}] Buyer asked: "${question}" — Ketu's answer: "${answer}"` })
const facts = [content('Oversize 240gsm Red restock?', '8-9 din mein aa jana chahiye')]
const block = formatTimedFactsBlock(facts, now)
assert.match(block, /4-5 days/)
assert.match(block, /DO NOT subtract days again/)
assert.doesNotMatch(block, /8-9/)
assert.match(formatTimedFactsBlock(facts, now, 'When will Red be available?'), /REPLY LANGUAGE: ENGLISH/)
assert.doesNotMatch(formatTimedFactsBlock(facts, now, 'Red kab available hoga?'), /REPLY LANGUAGE: ENGLISH/)
assert.equal(currentTimedFact(fact('minimum 8 days'), now).timingEstimate, 'minimum 4 days')
assert.equal(formatTimedFactsBlock([content('Red restock?', '2-3 days')], now), null)
assert.equal(formatTimedFactsBlock([{ content: 'invalid' }], now), null)
const snapshot = { fetchedAt: now, inStock: { 'Oversize 240gsm': { Red: { M: 1 }, White: { M: 1 } }, 'Kids Rneck': { Red: { '24': 1 } } }, oos: { 'Oversize 240gsm': { Red: 'M', White: 'M' }, 'Kids Rneck': { Red: '24' } }, coming: {} }
const stock = formatStockBlock(snapshot, { timedFacts: facts, now })
assert.match(stock, /Red \[out: M[^\n]*4-5 days/)
assert.doesNotMatch(stock, /8-9 din/)
assert.match(stock, /White \[out: M[^\n]*NO shipment/)
assert.match(stock, /Kids Rneck: Red \[out: 24[^\n]*NO shipment/)
const due = formatStockBlock(snapshot, { timedFacts: [content('Oversize 240gsm Red restock?', '2-3 days')], now })
assert.doesNotMatch(due, /⏰ Ketu said/)
assert.match(due, /NO shipment/)
console.log('Timing-age and stock-boundary checks passed')
