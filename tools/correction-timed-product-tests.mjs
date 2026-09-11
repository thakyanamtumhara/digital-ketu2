import assert from 'node:assert/strict'
import { resolveTimedFactProduct, timedFactFor, formatStockBlock } from '../server/stock-lookup.js'

const fact = (question, answer = '8-9 din mein aayega sir') => ({ content: `[stated 2026-09-10] Buyer asked: "${question}" — Ketu's answer: "${answer}"` })
const cases = [
  ['True Bio red restock kab?', 'True Bio Rneck'],
  ['truebio red restock kab?', 'True Bio Rneck'],
  ['True Bio Rneck red restock kab?', 'True Bio Rneck'],
  ['non-bio red restock kab?', 'Non Bio Rneck'],
  ['Non Bio Rneck red restock kab?', 'Non Bio Rneck'],
  ['Bio Rneck red restock kab?', 'Bio Rneck'],
  ['bio red restock kab?', 'Bio Rneck'],
  ['premium polo red restock kab?', 'Premium Polo'],
  ['cotton polo red restock kab?', 'Cotton Polo'],
  ['polo red restock kab?', null],
  ['polo red restock kab? Cotton polo red 8-9 din mein aayega', 'Cotton Polo'],
  ['hoodie red restock kab?', null],
  ['hoodie red restock kab? Zip hoodie 8-9 din mein aayega', 'Zip Hoodie'],
  ['320gsm hoodie red restock kab?', null],
  ['430gsm hoodie red restock kab?', null],
  ['Hoodie 320gsm-1 red restock kab?', 'Hoodie 320gsm-1'],
  ['Hoodie 320gsm-2 red restock kab?', 'Hoodie 320gsm-2'],
  ['Hoodie 430gsm-2 red restock kab?', 'Hoodie 430gsm-2'],
  ['Dropsho Hoodie 430gsm red restock kab?', 'Dropsho Hoodie 430gsm'],
  ['drop shoulder hoodie red restock kab?', 'Dropsho Hoodie 430gsm'],
  ['zip hoodie red restock kab?', 'Zip Hoodie'],
  ['sweatshirt red restock kab?', null],
  ['Sweatshirt-2 red restock kab?', 'Sweatshirt-2'],
  ['180 gsm kids red restock kab?', 'Kids Rneck'],
  ['240 gsm acid wash red restock kab?', 'AcidWash OS'],
  ['240 red restock kab?', 'Oversize 240gsm'],
  ['OS240 red restock kab?', 'Oversize 240gsm'],
  ['oversize 180 red restock kab?', 'Oversize 180gsm'],
  ['180 gsm oversize red restock kab?', 'Oversize 180gsm'],
  ['240 pcs chahiye', null],
  ['₹240 red restock kab?', null],
  ['1240 red restock kab?', null],
  ['True Bio and Non Bio red restock kab?', null],
  ['240 and 260 gsm red restock kab?', null],
]
for (const [text, expected] of cases) assert.equal(resolveTimedFactProduct(text), expected, text)

const facts = [fact('True Bio red restock kab?')]
assert.ok(timedFactFor(facts, 'True Bio Rneck', 'Red'))
assert.equal(timedFactFor(facts, 'Bio Rneck', 'Red'), null)
assert.equal(timedFactFor(facts, 'Non Bio Rneck', 'Red'), null)
assert.equal(timedFactFor([fact('Non Bio red restock kab?')], 'Bio Rneck', 'Red'), null)
assert.equal(timedFactFor([fact('Premium polo red restock kab?')], 'Cotton Polo', 'Red'), null)
assert.equal(timedFactFor([fact('zip hoodie red restock kab?')], 'Hoodie 320gsm-1', 'Red'), null)
assert.equal(timedFactFor([fact('hoodie red restock kab?')], 'Hoodie 320gsm-1', 'Red'), null)
assert.equal(timedFactFor([fact('hoodie red restock kab?')], 'Hoodie 430gsm-2', 'Red'), null)
assert.equal(timedFactFor([fact('Hoodie 320gsm-1 red restock kab?')], 'Hoodie 320gsm-2', 'Red'), null)
assert.equal(timedFactFor([fact('True Bio red restock kab?', 'Non Bio le lo sir')], 'True Bio Rneck', 'Red'), null)

const names = ['Bio Rneck', 'True Bio Rneck', 'Non Bio Rneck', 'Hoodie 320gsm-1', 'Hoodie 320gsm-2', 'Hoodie 430gsm-2']
const snapshot = {
  inStock: Object.fromEntries(names.map(name => [name, { Red: { S: 1 } }])),
  oos: Object.fromEntries(names.map(name => [name, { Red: 'M' }])),
  coming: {}, fetchedAt: Date.parse('2026-09-11T00:00:00Z'),
}
const block = formatStockBlock(snapshot, { timedFacts: [...facts, fact('hoodie red restock kab?')], now: snapshot.fetchedAt })
for (const name of names) {
  const row = block.split('\n').find(line => line.startsWith(`- ${name}: Red [out:`))
  assert.ok(row, `missing output row for ${name}`)
  if (name === 'True Bio Rneck') assert.match(row, /Ketu said/)
  else assert.doesNotMatch(row, /Ketu said|8-9/)
}
console.log(`${cases.length} product cases plus 22 attachment assertions passed`)
