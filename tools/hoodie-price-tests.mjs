import assert from 'node:assert/strict'
import { hoodieRateSummaryGuard } from '../server/hoodie-price.js'

const products = [{ slug: 'hoodie-320gsm', gsm: 320, bulkRange: [211, 251] }]
const base = { products, buyerText: 'Hello Hoodie price', reply: 'Hoodie 320gsm ₹211 (Black), baaki colours ₹239 sir 👉 https://sale91.com/catalog/p/hoodie-320gsm' }
let checks = 0
function eq(actual, expected) { assert.equal(actual, expected); checks++ }
eq(hoodieRateSummaryGuard(base), 'Hoodie 320gsm ₹211–₹251 bulk (10+ total pcs, colour/size ke hisaab se) sir 👉 https://sale91.com/catalog/p/hoodie-320gsm')
eq(hoodieRateSummaryGuard({ ...base, english: true }).includes('by colour/size'), true)
eq(hoodieRateSummaryGuard({ ...base, reply: 'Hoodie catalog 👉 https://sale91.com/catalog/p/hoodie-320gsm Colour bataiye sir?' }), null)
eq(hoodieRateSummaryGuard({ ...base, reply: base.reply + ' कल उपलब्ध होगा।' }), null)
eq(hoodieRateSummaryGuard({ ...base, products: [{ ...products[0], bulkRange: [253, 289] }] }).includes('₹253–₹289'), true)
eq(hoodieRateSummaryGuard({ ...base, products: [{ ...products[0], bulkRange: [253, 253] }] }).includes('₹253 bulk'), true)
for (const buyerText of ['Hoodie 320gsm price?', 'Hoodie ka rate kya hai']) eq(hoodieRateSummaryGuard({ ...base, buyerText }) !== null, true)
for (const buyerText of ['Black hoodie price', 'Hoodie XXL price', '2 hoodie samples', 'Hoodie 430gsm price', 'Zip hoodie price', 'Hoodie price and delivery', 'Hoodie refund', '[Image] Hoodie price', 'Hoodie price for 30 pcs']) eq(hoodieRateSummaryGuard({ ...base, buyerText }), null)
for (const reply of ['[DEFER]', 'Hoodie 320gsm ₹211–₹251 by size sir.', 'Hoodie 320gsm from ₹211 sir.', 'Hoodie 320gsm ₹211 se shuru sir.', 'Hoodie 320gsm S/M/L/XL ₹211, XXL ₹223 sir.', 'Hoodie 320gsm sample ₹277 sir.', 'Hoodie 320gsm ₹211 sir. Cotton fabric.', 'Hoodie 320gsm ₹211, 430gsm ₹351 sir.', 'Hoodie 320gsm ₹211 sir. Refund pending [DEFER]', 'Hoodie 320gsm ₹211 sir, extra discount available.', 'Which hoodie sir?', base.reply.replace('sale91.com', 'example.com')]) eq(hoodieRateSummaryGuard({ ...base, reply }), null)
for (const row of [{ buyerMessage: 'Black XXL please' }, { buyerMessage: '2 samples' }, { buyerMessage: '24 pcs total' }, { deferReason: 'manual_reply', aiReply: 'XXL black' }]) eq(hoodieRateSummaryGuard({ ...base, history: [row] }), null)
eq(hoodieRateSummaryGuard({ ...base, history: [{ deferReason: 'manual_reply', buyerMessage: 'XXL black', aiReply: 'Which product?' }] }) !== null, true)
for (const data of [[], [products[0], products[0]], [{ ...products[0], gsm: 430 }], [{ ...products[0], bulkRange: [251, 211] }], [{ ...products[0], bulkRange: [211, NaN] }], [{ ...products[0], bulkRange: [0, 251] }], [{ ...products[0], bulkRange: ['211', 251] }], [{ ...products[0], bulkRange: null }]]) eq(hoodieRateSummaryGuard({ ...base, products: data }), null)
const mixed = {
  products: [{ slug: 'hoodie-320gsm', gsm: 320, bulkRange: [307, 347] }],
  buyerText: 'Not received Yet —- Terry cotton hoodie Price Share pics',
  history: [
    { buyerMessage: 'Not received', aiReply: 'Ketu will reply shortly sir 🙏', status: 'DEFERRED' },
    { buyerMessage: '1 week hogea', aiReply: 'Ketu will reply shortly sir 🙏', status: 'DEFERRED' },
  ],
  reply: 'Hoodie 320gsm (loopknit) Black ₹307, baaki colours ₹337 sir. Saare photos swipe karke dekh lijiye 👉 https://www.bulkplaintshirt.com/?photos=hoodie-320gsm\n[DEFER]',
}
const correctedMixed = 'Hoodie 320gsm (loopknit) ₹307–₹347 bulk (10+ total pcs, colour/size ke hisaab se) sir. Saare photos swipe karke dekh lijiye 👉 https://www.bulkplaintshirt.com/?photos=hoodie-320gsm\n[DEFER]'
eq(hoodieRateSummaryGuard(mixed), correctedMixed)
eq(hoodieRateSummaryGuard({ ...mixed, english: true }), correctedMixed.replace('colour/size ke hisaab se', 'by colour/size'))
eq(hoodieRateSummaryGuard({ ...mixed, products: [{ ...mixed.products[0], bulkRange: [401, 449] }] }), correctedMixed.replace('₹307–₹347', '₹401–₹449'))
eq(hoodieRateSummaryGuard({ ...mixed, reply: mixed.reply.replace('Black ₹307, baaki colours ₹337', 'Black Rs. 307, other colors Rs. 337') }), correctedMixed)
eq(hoodieRateSummaryGuard({ ...mixed, reply: 'Your order issue needs checking sir.\n' + mixed.reply }), 'Your order issue needs checking sir.\n' + correctedMixed)
eq(hoodieRateSummaryGuard({ ...mixed, reply: mixed.reply.replace('sir. Saare', 'sir. Fabric is loopknit. Saare') }), correctedMixed.replace('sir. Saare', 'sir. Fabric is loopknit. Saare'))
for (const buyerText of ['Black hoodie price, order not received', 'Hoodie XXL price, order not received', 'Hoodie 2 samples price, order not received', 'Hoodie price for 30 pcs, order not received', 'Zip hoodie price, order not received', '[Image] Hoodie price, order not received', 'Hoodie 430gsm price, order not received', 'Hoodie 190gsm price, order not received', 'Oversize hoodie price, order not received', 'Acid wash hoodie price, order not received']) eq(hoodieRateSummaryGuard({ ...mixed, buyerText }), null)
for (const reply of [
  '[DEFER]', '[SKIP]', mixed.reply.replace('\n[DEFER]', ''),
  mixed.reply.replace('Black ₹307, baaki colours ₹337', 'Black from ₹307, baaki colours from ₹337'),
  mixed.reply.replace('Black ₹307, baaki colours ₹337', 'Black ₹307–₹317, baaki colours ₹337–₹347'),
  mixed.reply.replace('Black ₹307, baaki colours ₹337', 'Black ₹307, baaki colours ₹337 for S/M/L/XL'),
  mixed.reply.replace('Black ₹307, baaki colours ₹337', 'Black sample ₹378, baaki colours ₹414'),
  mixed.reply.replace('320gsm', '430gsm'),
  mixed.reply.replace('Black ₹307, baaki colours ₹337', 'Black ₹307 se, baaki colours ₹337 se'),
  'For S/M/L/XL: ' + mixed.reply,
  'S/M/L/XL:\n' + mixed.reply,
  'Sample prices: ' + mixed.reply,
]) eq(hoodieRateSummaryGuard({ ...mixed, reply }), null)
for (const history of [[{ buyerMessage: 'XXL hoodie please' }], [{ buyerMessage: '2 samples' }], [{ deferReason: 'manual_reply', aiReply: 'Black size M sir.' }]]) eq(hoodieRateSummaryGuard({ ...mixed, history }), null)
for (const products of [[], [mixed.products[0], mixed.products[0]], [{ ...mixed.products[0], bulkRange: [347, 307] }], [{ ...mixed.products[0], bulkRange: ['307', 347] }], [{ ...mixed.products[0], gsm: 430 }]]) eq(hoodieRateSummaryGuard({ ...mixed, products }), null)
console.log(`${checks} hoodie price checks passed`)
