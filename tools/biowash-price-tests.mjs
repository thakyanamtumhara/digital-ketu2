import assert from 'node:assert/strict'
import { biowashRateSummaryGuard, regularFitRateSummaryGuard } from '../server/biowash-price.js'

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
const regular = { products: products.map(p => ({ ...p, fit: 'regular', colors: ['Black', 'Mustard Yellow', 'Sky'] })), buyerText: '180 gsm regular fit price?', reply: '180gsm regular fit mein True Bio ₹131 aur Bio ₹111 hai sir 👉 https://sale91.com/catalog/p/true-biowash-round-neck' }
eq(regularFitRateSummaryGuard(regular), '180gsm regular fit: True Bio ₹131–₹141; Bio ₹111–₹121 bulk (10+ total pcs, colour/size ke hisaab se) sir 👉 https://sale91.com/catalog')
eq(regularFitRateSummaryGuard({ ...regular, reply: '180gsm regular fit mein True Bio ₹131, Bio ₹111, Non-Bio ₹91 hai sir 👉 https://sale91.com/catalog' }), regularFitRateSummaryGuard(regular))
eq(regularFitRateSummaryGuard({ ...regular, reply: 'Non Bio ₹91; Bio ₹111; True Bio ₹131 sir' }), regularFitRateSummaryGuard(regular))
eq(regularFitRateSummaryGuard({ ...regular, products: [...regular.products, { slug: 'new-regular', gsm: 180, fit: 'regular', bulkRange: [151, 161] }] }), null)
eq(regularFitRateSummaryGuard({ ...regular, english: true }).includes('by colour/size'), true)
eq(regularFitRateSummaryGuard({ ...regular, products: regular.products.map(p => ({ ...p, bulkRange: [181, 191] })) }).includes('True Bio ₹181–₹191; Bio ₹181–₹191'), true)
eq(regularFitRateSummaryGuard({ ...regular, products: regular.products.map(p => ({ ...p, bulkRange: [181, 181] })) }).includes('True Bio ₹181; Bio ₹181'), true)
for (const buyerText of ['180gsm regular fit rates', 'What is the price of 180 gsm regular fit t-shirts?', '180gsm regular fit ka price kya hai']) eq(regularFitRateSummaryGuard({ ...regular, buyerText }) !== null, true)
for (const buyerText of ['Regular fit price', '180gsm price', '180gsm regular fit sample price', '180gsm regular fit 44 price', '180gsm regular fit price for 10 pcs', '180gsm regular fit black price', '180gsm regular fit price and delivery', '180gsm regular fit price complaint', '180gsm oversize price', '180gsm regular fit True Bio price', '[Image] 180gsm regular fit price']) eq(regularFitRateSummaryGuard({ ...regular, buyerText }), null)
for (const reply of ['True Bio ₹131–₹141; Bio ₹111–₹121 bulk', 'True Bio from ₹131 and Bio from ₹111', 'True Bio size 38 ₹131, Bio size 38 ₹111', 'True Bio ₹161 sample, Bio ₹151 sample', 'True Bio ₹131; Bio ₹111; sample available', 'True Bio ₹131; Bio ₹111, both in stock', 'True Bio ₹131; Bio ₹111, 100% cotton', 'True Bio ₹131; Bio ₹111 [DEFER]', 'True Bio ₹131; Bio ₹111, delivery tomorrow', 'True Bio ₹131; Non Bio ₹111', 'True Bio ₹131; Bio ₹111, https://example.com', 'True Bio ₹131; Bio ₹111, https://sale91.com/catalog/p/oversize-180gsm', '[DEFER]', 'True Bio ₹131 sir', 'Bio ₹111, Bio ₹121']) eq(regularFitRateSummaryGuard({ ...regular, reply }), null)
for (const row of [{ buyerMessage: '44 chahiye' }, { buyerMessage: 'Mustard Yellow' }, { buyerMessage: 'Sky please' }, { buyerMessage: '2 samples' }, { buyerMessage: '6 pcs' }, { buyerMessage: 'True Bio' }, { buyerMessage: '[Image]' }, { deferReason: 'manual_reply', aiReply: 'Use size 46' }]) eq(regularFitRateSummaryGuard({ ...regular, history: [row] }), null)
eq(regularFitRateSummaryGuard({ ...regular, history: [{ buyerMessage: regular.buyerText, deferReason: 'welcome_followup_scheduled' }] }) !== null, true)
eq(regularFitRateSummaryGuard({ ...regular, history: [{ deferReason: 'manual_reply', buyerMessage: 'White 44', aiReply: 'Which product?' }] }) !== null, true)
eq(regularFitRateSummaryGuard({ ...regular, imageUrl: 'https://media.invalid/photo.jpg' }), null)
for (const change of [{ gsm: 200 }, { fit: 'oversize' }, { bulkRange: [0, 121] }, { bulkRange: [121, 111] }, { bulkRange: [111, NaN] }, { bulkRange: ['111', 121] }, { bulkRange: null }]) eq(regularFitRateSummaryGuard({ ...regular, products: [regular.products[0], { ...regular.products[1], ...change }] }), null)
for (const data of [[], [regular.products[0]], [...regular.products, regular.products[0]]]) eq(regularFitRateSummaryGuard({ ...regular, products: data }), null)
console.log(`${checks} biowash price checks passed`)
