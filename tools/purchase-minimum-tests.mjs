import assert from 'node:assert/strict'
import { purchaseMinimumGuard } from '../server/purchase-minimum.js'

const buyerText = 'What is the bulk price? I want to buy 30 pieces oversize in different sizes and colours'
const reply = '210gsm bulk rate ₹217/pc sir, 30 pcs minimum with all colours/sizes mix available 👉 https://sale91.com/catalog/p/oversize-210gsm'
const base = { buyerText, reply, english: true }
let checks = 0
const fixed = purchaseMinimumGuard(base)
assert.match(fixed, /₹217\/pc sir — no minimum order; bulk rate applies at 10\+ total pcs, colours\/sizes can be mixed/); checks++
assert.match(fixed, /https:\/\/sale91.com\/catalog\/p\/oversize-210gsm$/); checks++
assert.equal(purchaseMinimumGuard({ ...base, reply: fixed }), null); checks++
for (const patch of [
  { imageUrl: 'https://media.invalid/photo.jpg' },
  { english: false },
  { buyerText: 'I want to buy 30 pieces oversize' },
  { buyerText: 'What is the bulk price of oversize?' },
  { buyerText: 'I want to buy 30 pieces and 15 pieces, bulk price?' },
  { buyerText: 'I want to buy 10 pieces, bulk price?' },
  { buyerText: buyerText + ' with custom fit' },
  { buyerText: buyerText + ' with printing' },
  { buyerText: buyerText + ' with labels' },
  { buyerText: buyerText + ' coupon discount?' },
  { buyerText: buyerText + ' sample first?' },
  { buyerText: buyerText + ' payment failed' },
  { reply: '[DEFER]' },
  { reply: '[DEFER] ' + reply },
  { reply: reply.replace('30 pcs minimum', '10+ total pcs') },
  { reply: reply.replace('30 pcs minimum', 'not 30 pcs minimum') },
  { reply: reply.replace('30 pcs minimum', '50 pcs minimum') },
  { reply: reply.replace('30 pcs minimum', '30 pcs minimum for discount') },
  { reply: reply.replace('30 pcs minimum', '30 pcs minimum for printing') },
  { reply: reply.replace('oversize-210gsm', 'oversize-240gsm') },
  { reply: reply.replace('sale91.com', 'vendor.invalid') },
  { reply: reply + ' I will dispatch tomorrow.' },
]) {
  assert.equal(purchaseMinimumGuard({ ...base, ...patch }), null, JSON.stringify(patch)); checks++
}
for (const gsm of [180, 210, 240, 260]) {
  assert.match(purchaseMinimumGuard({ ...base, reply: reply.replaceAll('210', String(gsm)) }), /no minimum order/); checks++
}
assert.match(purchaseMinimumGuard({ ...base, reply: reply.replace(' with all colours/sizes mix available', '') }), /10\+ total pcs 👉/); checks++
console.log(`${checks} purchase-minimum checks passed`)
