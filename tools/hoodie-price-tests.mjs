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
console.log(`${checks} hoodie price checks passed`)
