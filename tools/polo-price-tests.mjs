import assert from 'node:assert/strict'
import { poloRateSummaryGuard, poloColourQuoteGuard } from '../server/polo-price.js'

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

const colourProducts = products.map((p, i) => ({ ...p, colors: ['Black', 'Navy'], sizes: ['36', '46'], rates: [{ colors: ['Black', 'Navy'], pricePerSize: { 36: p.bulkRange[0], 46: p.bulkRange[1] } }] }))
const colourBase = { products: colourProducts, buyerText: 'Hi Blue polo t shirt required 60 pcs', reply: 'Hello sir 🙏 Polo comes in Navy blue. Cotton Polo ₹211, Premium Polo ₹267 (60 pcs = bulk rate).\n👉 https://sale91.com/catalog/p/cotton-polo\n👉 https://sale91.com/catalog/p/premium-polo', english: true }
const colourOutput = poloColourQuoteGuard(colourBase)
assert.match(colourOutput, /^Navy: Cotton Polo ₹211–₹223; Premium Polo ₹267–₹279 bulk \(10\+ total pcs, by size\)/)
assert.match(poloColourQuoteGuard({ ...colourBase, reply: 'Hello sir 🙏 Polo comes in Navy Blue. Cotton Polo is ₹211/pc 👉 https://sale91.com/catalog/p/cotton-polo and Premium Polo is ₹267/pc 👉 https://sale91.com/catalog/p/premium-polo' }), /₹211–₹223; Premium Polo ₹267–₹279/)
for (const buyerText of ['Navy polo price', 'Black polo rates please', 'I want navy blue polo 80 pieces', 'blue polo chahiye']) assert.ok(poloColourQuoteGuard({ ...colourBase, buyerText, reply: base.reply }))
assert.match(poloColourQuoteGuard({ ...colourBase, english: false }), /by size/)
assert.match(poloColourQuoteGuard({ ...colourBase, buyerText: 'blue polo chahiye 60 pcs', english: false }), /size ke hisaab se/)
assert.equal(poloColourQuoteGuard({ ...colourBase, reply: colourOutput }), null)
for (const buyerText of ['Blue polo size 46 price', 'Blue polo 8 pcs', 'Blue polo sample', 'Blue polo 40', 'Blue polo 60 pcs 20 pcs', 'Blue polo and hoodie', 'Blue polo delivery tomorrow', 'Blue polo refund', 'Blue polo embroidery', 'Blue polo stock available', '[Image] Blue polo', 'Red polo price', 'Royal blue polo price', 'Cotton polo blue rate']) assert.equal(poloColourQuoteGuard({ ...colourBase, buyerText }), null, buyerText)
for (const reply of ['[DEFER]', colourBase.reply + ' [DEFER]', colourBase.reply + ' size 46 costs extra', colourBase.reply + ' sample ₹300', colourBase.reply + ' delivery tomorrow', colourBase.reply + ' all available', colourBase.reply.replace('₹211', '₹212'), colourBase.reply.replace('₹211', '₹211–₹223'), colourBase.reply.replace('₹211', 'starts at ₹211'), colourBase.reply + ' 5% GST', 'Cotton Polo ₹211 only', colourBase.reply.replace('60 pcs', '80 pcs')]) assert.equal(poloColourQuoteGuard({ ...colourBase, reply }), null, reply)
for (const buyerMessage of ['Size 46', '46', '40', 'M please', 'A sample please', '2 pcs', '[Image]']) assert.equal(poloColourQuoteGuard({ ...colourBase, history: [{ buyerMessage }] }), null, buyerMessage)
assert.ok(poloColourQuoteGuard({ ...colourBase, history: [{ buyerMessage: '40 pcs' }] }))
assert.equal(poloColourQuoteGuard({ ...colourBase, history: [{ deferReason: 'manual_reply', aiReply: 'Size 46' }] }), null)
assert.ok(poloColourQuoteGuard({ ...colourBase, history: [{ buyerMessage: 'Size 46', createdAt: new Date(Date.now() - 3 * 3600000).toISOString() }] }))
assert.equal(poloColourQuoteGuard({ ...colourBase, imageUrl: 'https://media.invalid/polo.jpg' }), null)
for (const bad of [[], colourProducts.slice(1), [...colourProducts, colourProducts[0]], colourProducts.map(p => ({ ...p, rates: [] })), colourProducts.map(p => ({ ...p, colors: [...p.colors, 'Royal Blue'] })), colourProducts.map(p => ({ ...p, rates: [...p.rates, p.rates[0]] })), colourProducts.map(p => ({ ...p, rates: [{ colors: p.colors, pricePerSize: { 36: 211 } }] })), colourProducts.map(p => ({ ...p, rates: [{ colors: p.colors, pricePerSize: { 36: 211, 46: NaN } }] }))]) assert.equal(poloColourQuoteGuard({ ...colourBase, products: bad }), null)
const changed = colourProducts.map(p => ({ ...p, rates: p.rates.map(r => ({ ...r, pricePerSize: { 36: r.pricePerSize[36], 46: r.pricePerSize[46] + 7 } })) }))
assert.match(poloColourQuoteGuard({ ...colourBase, products: changed }), /₹211–₹230; Premium Polo ₹267–₹286/)
console.log('PASS selected-colour polo source ranges, quantity versus size, source changes and exception controls')
