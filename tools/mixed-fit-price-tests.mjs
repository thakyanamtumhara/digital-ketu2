import assert from 'node:assert/strict'
import { mixedFitRegularPriceGuard as guard } from '../server/biowash-price.js'
const products = [
  { slug: 'non-bio-round-neck', gsm: 180, bulkRange: [91, 97], colors: ['Black'] },
  { slug: 'biowash-round-neck', gsm: 180, bulkRange: [121, 127], colors: ['Sky', 'Mustard Yellow'] },
  { slug: 'true-biowash-round-neck', gsm: 180, bulkRange: [141, 147], colors: ['Royal Blue'] },
]
const suffix = '. Oversize: 180gsm ₹181, 210gsm ₹201, 240gsm ₹221, 260gsm ₹191 se (size ke hisaab se). Ye 10+ pcs ke rates hain, fixed price hai. https://sale91.com/catalog'
const base = { products, buyerText: 'Dono chahiye, gsm ke according rate batao', history: [{ buyerMessage: 'Tshirt chahiye', aiReply: 'Regular fit ya oversize?' }], reply: 'Dono hain sir. Regular fit (180gsm): Non-Bio ₹91, Bio ₹121, True Bio ₹141' + suffix }
let checks = 0
const eq = (a, b) => { assert.equal(a, b); checks++ }
const expected = 'Dono hain sir. Regular fit (180gsm): Non-Bio ₹91–₹97, Bio ₹121–₹127, True Bio ₹141–₹147' + suffix
eq(guard(base), expected)
eq(guard({ ...base, reply: base.reply.replace('(180gsm)', '180gsm') }), expected.replace('(180gsm)', '180gsm'))
eq(guard({ ...base, reply: expected }), null)
eq(guard({ ...base, products: products.map(p => ({ ...p, bulkRange: [101, 111] })) }).includes('Non-Bio ₹101–₹111, Bio ₹101–₹111, True Bio ₹101–₹111'), true)
eq(guard({ ...base, products: products.map(p => ({ ...p, bulkRange: [101, 101] })) }).includes('Non-Bio ₹101, Bio ₹101, True Bio ₹101.'), true)
eq(guard({ ...base, imageUrl: 'https://media.invalid/photo' }), null)
for (const text of ['GSM rate 40 pcs', 'GSM price black', 'GSM price Sky', 'GSM price Royal Blue', 'GSM price size M', 'GSM price sample', 'GSM rate refund', 'GSM price stock', 'GSM price cotton', 'GSM price bio', 'GSM price delivery', '[Image] GSM price', 'GSM price https://example.com', 'Which GSM?', 'Price please']) eq(guard({ ...base, buyerText: text }), null)
for (const row of [{ buyerMessage: 'White L' }, { buyerMessage: '20 pcs' }, { buyerMessage: 'sample' }, { buyerMessage: 'Mustard Yellow' }, { buyerMessage: 'https://example.com/product' }, { deferReason: 'manual_reply', aiReply: 'Ok' }, { isMedia: true }, { buyerMessage: 'Refund pending' }]) eq(guard({ ...base, history: [row] }), null)
for (const reply of [base.reply + ' [DEFER]', base.reply + ' sample ₹160', base.reply.replace('10+ pcs', '6 pcs'), base.reply.replace('Oversize:', 'Polo:'), base.reply.replace('Non-Bio ₹91', 'Non-Bio from ₹91'), base.reply.replace('Bio ₹121,', 'Bio size 38 ₹121,'), base.reply.replace('Regular fit (180gsm)', 'Regular fit (190gsm)'), base.reply.replace('Non-Bio ₹91,', ''), base.reply.replace('True Bio ₹141', 'True Bio ₹141–₹147'), base.reply.replace('Non-Bio ₹91,', 'Non-Bio ₹91, Non-Bio ₹91,'), base.reply + '\nRegular fit (180gsm): Non-Bio ₹91, Bio ₹121, True Bio ₹141.']) eq(guard({ ...base, reply }), null)
for (const data of [[], products.slice(0, 2), [...products, products[0]], [{ ...products[0], gsm: 190 }, ...products.slice(1)]]) eq(guard({ ...base, products: data }), null)
for (const bulkRange of [null, [], [0, 1], [2, 1], [1, NaN], ['1', 2]]) eq(guard({ ...base, products: [{ ...products[0], bulkRange }, ...products.slice(1)] }), null)
console.log(`${checks} mixed-fit price checks passed`)
