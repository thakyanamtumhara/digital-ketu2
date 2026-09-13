import assert from 'node:assert/strict'
import { discontinuedSizeRequest, discontinuedSizeGuard } from '../server/discontinued-size.js'
import { formatStockBlock } from '../server/stock-lookup.js'

const now = Date.now()
const snapshot = {
  fetchedAt: now,
  inStock: { 'Oversize 240gsm': { 'Off-white': { XS: 1, S: 1, M: 1, L: 1 }, Red: { XS: 1, M: 1 }, Black: { XS: 1 }, White: { XS: 1 } } },
  oos: { 'Oversize 240gsm': { 'Off-white': 'XS,S,M', Black: 'XS', White: 'XS' } }, coming: {},
}
const buyerText = 'I need oversized 240 gsm off white XS S M sizes'
const guard = (extra = {}) => discontinuedSizeGuard({ buyerText, reply: 'Off-white XS/S will arrive in 4 days.', snapshot, now, ...extra })
assert.deepEqual(discontinuedSizeRequest(buyerText)?.sizes, ['XS', 'S', 'M'])
assert.match(guard(), /Off-white XS won't be restocked/)
assert.match(guard(), /S\/M are out of stock now/)
assert.doesNotMatch(guard(), /\bdays?\b|Coming Soon|\[DEFER\]/)
assert.match(guard({ snapshot: null }), /won't be restocked.*\[DEFER\]/)
assert.match(guard({ snapshot: { ...snapshot, fetchedAt: now - 300001 } }), /\[DEFER\]/)
assert.match(guard({ snapshot: { ...snapshot, fetchedAt: now + 1 } }), /\[DEFER\]/)
assert.match(guard({ buyerText: '240gsm Red XS M available?' }), /Remaining XS\/M are available now/)
assert.match(guard({ buyerText: '240gsm Off-white XS L available?' }), /L is available now/)
assert.deepEqual(discontinuedSizeRequest('240gsm Off-white XS to XL stock?')?.sizes, ['XS', 'S', 'M', 'L', 'XL'])
for (const text of [
  'I need 240gsm Black XS', '240gsm White XS available?', '260gsm Off-white XS stock?',
  '240gsm Off-white M available?', 'Off-white XS available?', '240gsm White and Off-white XS available?',
  'I ordered 240gsm Off-white XS but received wrong size', '240gsm Off-white XS stock and refund update?',
  '240gsm Off-white XS price?', '240gsm Off-white XS nahi chahiye, M chahiye',
  'I want 240gsm Off-white XS with printing', '240gsm Off-white XS size chart?',
]) assert.equal(guard({ buyerText: text }), null, text)
assert.equal(guard({ reply: '[DEFER]' }), null)
assert.equal(guard({ reply: 'Photos here. [DEFER]' }), null)
const date = new Date(now + 19800000).toISOString().slice(0, 10)
const block = formatStockBlock(snapshot, { now, timedFacts: [{ content: `[stated ${date}] Buyer asked: "Oversize 240gsm restock?" — Ketu's answer: "6 days"` }] })
assert.match(block, /Off-white \[out: XS,S,M[^\n]*XS is discontinued for Off-white[^\n]*S,M only: ⏰/)
assert.match(block, /Black \[out: XS[^\n]*Ketu said/)
assert.match(block, /White \[out: XS[^\n]*Ketu said/)
console.log('27 discontinued-size assertions passed')
