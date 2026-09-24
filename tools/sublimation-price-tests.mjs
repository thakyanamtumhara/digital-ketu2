import assert from 'node:assert/strict'
import { sublimationPriceGuard } from '../server/sublimation-price.js'

const product = { slug: 'sublimation-t-shirt', colors: ['White'], sizes: ['36', '44'], rates: [{ colors: ['White'], pricePerSize: { 36: 131, 44: 139 } }], sampleRange: [157, 157] }
const reply = 'Polyester mein Sublimation T-shirt hai sir, sirf White — ₹131 (10+ pcs), sample ₹157 👉 https://sale91.com/catalog/p/sublimation-t-shirt'
const base = { buyerText: 'Polyester tshirt price', reply, products: [product] }
let count = 0
const equal = (a, b) => { assert.equal(a, b); count++ }
equal(sublimationPriceGuard(base), reply.replace('₹131', '₹131–₹139 (size ke hisaab se)'))
equal(sublimationPriceGuard({ ...base, reply: sublimationPriceGuard(base) }), null)
equal(sublimationPriceGuard({ ...base, reply: 'Sublimation T-shirt is ₹131 for 10+ total pcs; sample ₹157' }), 'Sublimation T-shirt is ₹131–₹139 (by size) for 10+ total pcs; sample ₹157')
equal(sublimationPriceGuard({ ...base, products: [{ ...product, rates: [{ colors: ['White'], pricePerSize: { 36: 131, 44: 144 } }] }] }), reply.replace('₹131', '₹131–₹144 (size ke hisaab se)'))
for (const buyerText of ['Polyester size 36 price', 'Sublimation 44 price', 'Polyester sample price', 'Polyester 4 pcs price', 'Polyester 20 pcs price', 'Polyester price refund', 'Polyester price and hoodie', 'Polyester price with printing', 'Polyester stock price', 'Polyester price dispatch', 'Polyester price [Image]', 'What is the return policy for polyester?']) equal(sublimationPriceGuard({ ...base, buyerText }), null)
for (const output of [reply + ' [DEFER]', '[DEFER]', reply + ' in stock', reply + ' GST extra', reply + ' size 44 extra', reply.replace('₹131', 'from ₹131'), reply.replace('₹131', '₹139'), reply.replace('₹157', '₹158'), reply.replace('sample ₹157', 'sample ₹157–₹160'), reply.replace('10+ pcs', '5+ pcs'), reply.replace('/p/sublimation-t-shirt', '/p/cotton-polo'), 'Sample Sublimation T-shirt ₹131 (10+ pcs)', reply + ' Cotton Polo ₹199']) equal(sublimationPriceGuard({ ...base, reply: output }), null)
for (const history of [[{buyerMessage: 'Size 36'}], [{deferReason: 'manual_reply', aiReply: 'I will check'}], [{isMedia: true, buyerMessage: 'Hi'}], [{buyerMessage: '4 pcs'}], [{buyerMessage: 'sublimation complaint'}]]) equal(sublimationPriceGuard({ ...base, history }), null)
equal(sublimationPriceGuard({ ...base, history: [{buyerMessage: 'Hi', createdAt: new Date().toISOString()}] }), sublimationPriceGuard(base))
equal(sublimationPriceGuard({ ...base, imageUrl: 'inspected-test-image' }), null)
for (const products of [[], [product, product], [{...product, colors: ['White','Black']}], [{...product, colors: null}], [{...product, sizes: []}], [{...product, sizes: ['36','36']}], [{...product, rates: null}], [{...product, rates: [{colors: ['White'],pricePerSize:{36:131}}]}], [{...product, rates: [{colors: ['White'],pricePerSize:{36:131,44:NaN}}]}], [{...product, rates: [{colors: ['White'],pricePerSize:{36:131,44:131}}]}], [{...product, sampleRange: [157,160]}]]) equal(sublimationPriceGuard({ ...base, products }), null)
console.log(`PASS ${count} source-derived sublimation price and neighbouring boundary checks`)
