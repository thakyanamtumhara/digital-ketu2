import assert from 'node:assert/strict'
import { biowashRateSummaryGuard } from '../server/biowash-price.js'

const products = [
  { slug: 'biowash-round-neck', gsm: 180, bulkRange: [111, 121], sampleRange: [151, 151] },
  { slug: 'true-biowash-round-neck', gsm: 180, bulkRange: [131, 141], sampleRange: [161, 171] },
]
const base = { products, buyerText: 'Bhai biowash ka price kya hai?', reply: '180gsm Bio Rneck ₹111 hai bhai (10+ pcs pe) 👉 https://sale91.com/catalog/p/biowash-round-neck' }
let checks = 0
function eq(actual, expected) { assert.equal(actual, expected); checks++ }
eq(biowashRateSummaryGuard(base), 'Bio Rneck 180gsm ₹111–₹121 bulk (10+ total pcs, colour/size ke hisaab se) bhai 👉 https://sale91.com/catalog/p/biowash-round-neck')
eq(biowashRateSummaryGuard({ ...base, english: true }).includes('by colour/size) sir'), true)
eq(biowashRateSummaryGuard({ ...base, buyerText: 'True biowash price?', reply: 'True Bio Rneck ₹131 sir.' }).includes('True Bio Rneck 180gsm ₹131–₹141'), true)
eq(biowashRateSummaryGuard({ ...base, buyerText: 'Biowash round neck rate', reply: 'Biowash Round Neck ₹111 sir' }) !== null, true)
eq(biowashRateSummaryGuard({ ...base, products: [{ ...products[0], bulkRange: [151, 171] }] }).includes('₹151–₹171'), true)
eq(biowashRateSummaryGuard({ ...base, products: [{ ...products[0], bulkRange: [151, 151] }] }).includes('₹151 bulk'), true)
for (const buyerText of ['Bio wash 180gsm k kya price h', 'Please share the Bio Rneck rate', 'True Bio wash rate list']) {
  const reply = buyerText.startsWith('True') ? 'True Bio Rneck ₹131 sir' : base.reply
  eq(biowashRateSummaryGuard({ ...base, buyerText, reply }) !== null, true)
}
for (const buyerText of ['Bio wash 44 price', 'Black Bio wash price', '2 biowash samples price', 'Bio wash price for 40 pcs', 'Bio wash price and delivery', 'Bio wash refund price', '[Image] Bio wash price', 'Non bio price', 'Bio and True Bio price', 'Bio wash 200gsm rate', 'Bio wash', 'Bio price discount code']) eq(biowashRateSummaryGuard({ ...base, buyerText }), null)
for (const reply of ['[DEFER]', 'Bio Rneck ₹111–₹121 sir', 'Bio Rneck ₹111–121 sir', 'Bio Rneck from ₹111 sir', 'Bio Rneck 36/38/40/42 ₹111, 44/46 ₹121 sir', 'Bio Rneck size M ₹111 sir', 'Bio Rneck sample ₹151 sir', 'Bio Rneck ₹111 sir, 100% cotton', 'Bio Rneck ₹111 sir, refund pending [DEFER]', 'Bio Rneck ₹111 sir, kal milega', 'Bio Rneck ₹111 sir, in stock', 'True Bio Rneck ₹131 sir', 'Non bio ₹111 sir', 'Bio Rneck ₹111; True Bio Rneck ₹131 sir', base.reply.replace('sale91.com', 'example.com'), base.reply.replace('/biowash-round-neck', '/true-biowash-round-neck')]) eq(biowashRateSummaryGuard({ ...base, reply }), null)
for (const row of [{ buyerMessage: '44 chahiye' }, { buyerMessage: 'Black please' }, { buyerMessage: '2 samples' }, { buyerMessage: '6 pcs' }, { deferReason: 'manual_reply', aiReply: 'Size 46' }]) eq(biowashRateSummaryGuard({ ...base, history: [row] }), null)
eq(biowashRateSummaryGuard({ ...base, history: [{ deferReason: 'manual_reply', buyerMessage: 'Black 44', aiReply: 'Which product?' }] }) !== null, true)
eq(biowashRateSummaryGuard({ ...base, history: [{ buyerMessage: 'All sizes same rate?' }, { buyerMessage: 'Can I order online?' }] }) !== null, true)
for (const data of [[], [products[0], products[0]], [{ ...products[0], gsm: 210 }], [{ ...products[0], bulkRange: [121, 111] }], [{ ...products[0], bulkRange: [111, NaN] }], [{ ...products[0], bulkRange: [0, 121] }], [{ ...products[0], bulkRange: ['111', 121] }], [{ ...products[0], bulkRange: null }]]) eq(biowashRateSummaryGuard({ ...base, products: data }), null)
const bulkSample = { products, english: true, buyerText: 'Please tell me the price of regular fit 180gsm biowash t-shirt', reply: 'Biowash Round Neck 180gsm — ₹111/pc bulk, ₹151 sample sir.\nhttps://sale91.com/catalog/p/biowash-round-neck\nBiowash Round Neck 👆' }
eq(biowashRateSummaryGuard(bulkSample), 'Bio Rneck 180gsm ₹111–₹121 bulk (10+ total pcs, by colour/size); ₹151 sample sir 👉 https://sale91.com/catalog/p/biowash-round-neck')
eq(biowashRateSummaryGuard({ ...bulkSample, buyerText: 'What is the price of True Biowash regular fit?', reply: 'True Bio 180gsm bulk ₹131/pc, sample ₹161 sir' }), 'True Bio Rneck 180gsm ₹131–₹141 bulk (10+ total pcs, by colour/size); ₹161–₹171 sample sir 👉 https://sale91.com/catalog/p/true-biowash-round-neck')
eq(biowashRateSummaryGuard({ ...bulkSample, buyerText: 'Biowash price', reply: 'Bio Rneck bulk ₹111, sample ₹151 sir' }) !== null, true)
for (const buyerText of ['Biowash sample price', 'Regular fit biowash price for 40 pcs', 'What is the price of black biowash tshirt', 'Biowash price and delivery?', 'Oversize biowash price']) eq(biowashRateSummaryGuard({ ...bulkSample, buyerText }), null)
for (const reply of ['Bio Rneck ₹111–₹121 bulk, ₹151 sample sir', 'Bio Rneck ₹111 bulk, sample from ₹151 sir', 'Bio Rneck ₹111 bulk, ₹151 sample, 100% cotton', 'Bio Rneck ₹111 bulk, ₹151 sample, available now', 'Bio Rneck ₹111 bulk, ₹151 sample [DEFER]', 'Bio Rneck ₹111 bulk, True Bio ₹161 sample', 'Bio Rneck size 46 ₹121 bulk, ₹151 sample']) eq(biowashRateSummaryGuard({ ...bulkSample, reply }), null)
for (const sampleRange of [undefined, null, [], [151, 0], [151, NaN], ['151', 161], [171, 151]]) eq(biowashRateSummaryGuard({ ...bulkSample, products: [{ ...products[0], sampleRange }] }), null)
for (const history of [[{ buyerMessage: 'White please' }], [{ buyerMessage: '2 pieces' }], [{ deferReason: 'manual_reply', aiReply: 'Size 44' }]]) eq(biowashRateSummaryGuard({ ...bulkSample, history }), null)
console.log(`${checks} biowash price checks passed`)
