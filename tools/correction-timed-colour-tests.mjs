import assert from 'node:assert/strict'
import { timedFactFor, formatStockBlock } from '../server/stock-lookup.js'

const fact = (question, answer = '8-9 din mein aayega sir') => ({ content: `[stated 2026-09-10] Buyer asked: "${question}" — Ketu's answer: "${answer}"` })
const facts = [fact('240 gsm oversized Red and off white restock kab aayega')]
assert.equal(timedFactFor(facts, 'Oversize 240gsm', 'White'), null)
assert.equal(timedFactFor([fact('240 off  white kab aayega')], 'Oversize 240gsm', 'White'), null)
assert.ok(timedFactFor(facts, 'Oversize 240gsm', 'Off-white'))
assert.ok(timedFactFor(facts, 'Oversize 240gsm', 'Red'))
assert.equal(timedFactFor(facts, 'Kids Rneck', 'Red'), null)
assert.ok(timedFactFor([fact('240 white and off-white restock kab aayega')], 'Oversize 240gsm', 'White'))
assert.ok(timedFactFor([fact('240 restock kab aayega')], 'Oversize 240gsm', 'White'))
assert.equal(timedFactFor([fact('240 Royal Blue restock kab aayega')], 'Oversize 240gsm', 'Blue'), null)
assert.ok(timedFactFor([fact('240 Royal Blue restock kab aayega')], 'Oversize 240gsm', 'Royal Blue'))
assert.ok(timedFactFor([fact('240 gray restock kab aayega')], 'Oversize 240gsm', 'Grey'))

const snapshot = {
  inStock: { 'Oversize 240gsm': { White: { S: 1 }, 'Off-white': { S: 1 }, Red: { S: 1 } } },
  oos: { 'Oversize 240gsm': { White: 'XS', 'Off-white': 'M', Red: 'M' } },
  coming: {}, fetchedAt: Date.parse('2026-09-11T00:00:00Z'),
}
const block = formatStockBlock(snapshot, { timedFacts: facts, now: snapshot.fetchedAt })
const whiteVerdict = block.match(/White \[out: XS[^\]]*\]/)?.[0]
assert.ok(whiteVerdict)
assert.match(whiteVerdict, /NO shipment/)
assert.doesNotMatch(whiteVerdict, /Ketu said|8-9/)
assert.match(block, /Off-white \[out: M[^\]]*Ketu said/)
console.log('14 timed-colour assertions passed')
