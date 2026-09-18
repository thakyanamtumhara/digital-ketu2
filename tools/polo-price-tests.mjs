import assert from 'node:assert/strict'
import { poloRateSummaryGuard } from '../server/polo-price.js'

const products = [{ slug: 'cotton-polo', gsm: 220, bulkRange: [211, 223] }, { slug: 'premium-polo', gsm: 220, bulkRange: [267, 279] }]
const base = { products, buyerText: 'polo', reply: 'Cotton Polo ₹211, Premium Polo ₹267 hai sir (10+ pcs pe) 👉 https://sale91.com/catalog' }
const output = poloRateSummaryGuard(base)
assert.match(output, /Cotton Polo ₹211–₹223; Premium Polo ₹267–₹279/)
assert.match(output, /bulk \(10\+ total pcs, colour\/size/)
assert.match(poloRateSummaryGuard({ ...base, buyerText: 'Please share polo prices', english: true }), /by colour\/size/)
const optionsReply = 'Polo comes in 2 options sir — Cotton Polo ₹211 👉 https://sale91.com/catalog/p/cotton-polo, Premium Polo ₹267 👉 https://sale91.com/catalog/p/premium-polo'
for (const buyerText of ['We need polo tshirt', 'I want polo', 'We want polo t-shirts', 'I need polo prices']) {
  for (const reply of [base.reply, optionsReply, optionsReply.replace('comes in 2 options', 'mein 2 option hai')]) assert.match(poloRateSummaryGuard({ ...base, buyerText, reply, english: true }), /₹211–₹223; Premium Polo ₹267–₹279.*10\+ total pcs, by colour\/size/)
}
assert.match(poloRateSummaryGuard({ ...base, reply: optionsReply }), /₹211–₹223; Premium Polo ₹267–₹279/)
for (const buyerText of ['We need polo size 46', 'We need 2 polo samples', 'I want polo delivery tomorrow', 'We need polo printing', 'I want my polo refund', 'We need polo and hoodie']) assert.equal(poloRateSummaryGuard({ ...base, buyerText, reply: optionsReply }), null, buyerText)
for (const prefix of ['Polo comes in 3 options sir — ', 'Polo comes in 2 pcs sir — ', 'Polo comes in 2 samples sir — ', 'Polo mein 2 pcs hai sir — ', 'Polo mein 3 option hai sir — ']) assert.equal(poloRateSummaryGuard({ ...base, reply: optionsReply.replace(/^.*?— /, prefix) }), null, prefix)
for (const buyerText of ['Please send me the details of both polo t-shirts.', 'Polo tshirt details please', 'Share polo t shirt price list']) {
  assert.match(poloRateSummaryGuard({ ...base, buyerText, english: true }), /Cotton Polo ₹211–₹223; Premium Polo ₹267–₹279.*by colour\/size/)
}
for (const buyerText of ['Share polo t-shirt fabric details', 'Details of polo delivery', 'Polo t-shirts size 46 details', 'Details of polo sample prices', 'Details of polo and hoodie', 'Details of my polo order']) {
  assert.equal(poloRateSummaryGuard({ ...base, buyerText }), null, buyerText)
}
assert.ok(poloRateSummaryGuard({ ...base, history: [{ buyerMessage: 'Around 1200pcs for a college event, rate kya hoga?' }] }))
assert.ok(poloRateSummaryGuard({ ...base, history: [{ buyerMessage: 'Hi, a question about Cotton Polo https://sale91.com/catalog/p/cotton-polo' }] }))
assert.equal(poloRateSummaryGuard({ ...base, reply: output }), null)
assert.match(poloRateSummaryGuard({ ...base, reply: 'Polo mein Cotton Polo ₹211 aur Premium Polo ₹267 hai sir (220gsm)' }), /₹211–₹223.*₹267–₹279 \(220gsm\)/)
assert.equal(poloRateSummaryGuard({ ...base, reply: base.reply + ' (180gsm)' }), null)
assert.equal(poloRateSummaryGuard({ ...base, reply: base.reply + ' 100% cotton' }), null)
assert.match(poloRateSummaryGuard({ ...base, reply: 'Polo 2 hain sir — Cotton Polo ₹211 👉 https://sale91.com/catalog/p/cotton-polo, Premium Polo ₹267 👉 https://sale91.com/catalog/p/premium-polo', english: true }), /₹211–₹223.*₹267–₹279.*by colour\/size/)
for (const prefix of ['Polo 2 pcs hain sir — ', 'Polo 2 samples hain sir — ', 'Polo 3 hain sir — ', '2 Cotton Polo — ']) assert.equal(poloRateSummaryGuard({ ...base, reply: prefix + base.reply }), null, prefix)
assert.match(poloRateSummaryGuard({ ...base, products: products.map(p => ({ ...p, bulkRange: p.bulkRange.map(n => n + 10) })) }), /₹221–₹233.*₹277–₹289/)

for (const buyerText of ['Cotton Polo size 46 price', '2 polo samples', 'Polo price and delivery time', 'Polo refund', 'kids polo', 'polo navy', 'polo fabric', '[Image] polo', '?', 'hoodie rates']) assert.equal(poloRateSummaryGuard({ ...base, buyerText }), null, buyerText)
for (const buyerMessage of ['Size 46', 'Navy colour', 'White polo', 'Need M size', '2pcs please', '8 pieces', 'Sample please', 'Kids polo']) assert.equal(poloRateSummaryGuard({ ...base, history: [{ buyerMessage }] }), null, buyerMessage)
assert.equal(poloRateSummaryGuard({ ...base, history: [{ buyerMessage: 'mispaired buyer', deferReason: 'manual_reply', aiReply: 'White 46' }] }), null)
for (const reply of ['Which polo do you need?', '[DEFER]', base.reply + ' [DEFER]', 'Cotton Polo ₹211; Premium Polo ₹267 sample', 'Cotton Polo starts at ₹211; Premium Polo starts at ₹267', 'Cotton Polo ₹211–₹223; Premium Polo ₹267–₹279', base.reply + ' fabric is cotton', 'Cotton Polo size 46 ₹223; Premium Polo size 46 ₹279', 'Cotton Polo ₹211; Premium Polo ₹267. Delivery tomorrow']) assert.equal(poloRateSummaryGuard({ ...base, reply }), null, reply)
for (const invalid of [[], products.slice(1), [...products, products[0]], [{ ...products[0], bulkRange: [211, NaN] }, products[1]], [{ ...products[0], bulkRange: [223, 211] }, products[1]], [{ ...products[0], bulkRange: [211, null] }, products[1]]]) assert.equal(poloRateSummaryGuard({ ...base, products: invalid }), null)
console.log('PASS polo summary ranges, fresh prices, selected variants, samples, mixed tasks, handoffs and invalid-source controls')
