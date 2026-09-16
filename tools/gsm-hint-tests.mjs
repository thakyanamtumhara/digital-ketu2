// Regression: GSM-ALONE RESOLVER (2026-09-06). Pure.
import { gsmAmbiguityHint, catalogProductsFromChunks, gsmPriceRangeGuard } from '../server/gsm-hint.js'
import assert from 'node:assert/strict'
import { buildCatalogFacts } from '../server/catalog-facts.js'
const P = catalogProductsFromChunks([
  { title: 'True Biowash Round Neck', metadata: { gsm: 180, bulkPrice: 150 } },
  { title: 'Biowash Round Neck', metadata: JSON.stringify({ gsm: 180, bulkPrice: 142 }) },
  { title: 'Oversize 180gsm', metadata: { gsm: 180, bulkPrice: 177 } },
  { title: 'Oversize 240gsm', metadata: { gsm: 240, bulkPrice: 195 } },
  { title: 'AcidWash Oversize', metadata: { gsm: 240, bulkPrice: 238 } },
  { title: 'Shorts', metadata: { gsm: 240, bulkPrice: 217 } },
  { title: 'Cotton Polo', metadata: { gsm: 220, bulkPrice: 187 } },
  { title: 'Premium Polo', metadata: { gsm: 220, bulkPrice: 237 } },
  { title: 'No GSM product', metadata: {} },
])
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(60)} got=${got} want=${want}`) }
const h = gsmAmbiguityHint(P, '180 gsm pe\n10+ piece pe kya price lgega??')
t('MISS 15:36: bare 180 gsm → hint fires', !!h, true)
t('legacy minima are not promoted to unqualified prices', !/₹\d/.test(h || '') && /True Biowash Round Neck.*Biowash Round Neck.*Oversize 180gsm/.test(h || ''), true)
t('240 gsm (plain + speciality) → LEAD line, no ask', /LEAD with Oversize 240gsm as the answer/.test(gsmAmbiguityHint(P, '240 gsm 100 pcs ka rate') || ''), true)
t('180 gsm (different fits) → ASK line', /180gsm exists in 3 products.*ASK the fit/.test(gsmAmbiguityHint(P, '180 gsm ka rate') || ''), true)
t('180 gsm oversize (fit named) → no hint', gsmAmbiguityHint(P, '180 gsm oversize ka rate'), null)
t('round neck 180 (family named) → no hint', gsmAmbiguityHint(P, 'Round neck t shirt how much 180 gsn'), null)
t('220 gsm polo (named) → no hint', gsmAmbiguityHint(P, '220 gsm polo ka rate'), null)
t('bare 220 gsm → hint (two polos)', /220gsm exists in 2 products/.test(gsmAmbiguityHint(P, '220 gsm kitne ki hai') || ''), true)
t('"180 gsn" typo counts', !!gsmAmbiguityHint(P, 'plain tshirt 180 gsn price'), true)
t('no gsm → nothing', gsmAmbiguityHint(P, 'black tshirt ka rate'), null)
t('unknown gsm → nothing', gsmAmbiguityHint(P, '300 gsm hai?'), null)
const current = buildCatalogFacts({ categories: [{ products: [
  { name: 'Example Round Neck', slug: 'example-round-neck', gsm: 180, colors: ['Black', 'White'], sizes: ['M', 'XXL'], rates: [
    { colors: ['Black'], pricePerSize: { M: 211, XXL: 223 }, samplePrice: 277 },
    { colors: ['White'], pricePerSize: { M: 239, XXL: 251 }, samplePrice: 299 },
  ] },
  { name: 'Oversize 180gsm', slug: 'oversize-180gsm', gsm: 180, colors: ['Black'], sizes: ['M'], rates: [
    { colors: ['Black'], pricePerSize: { M: 313 }, samplePrice: 379 },
  ] },
] }] })
const scoped = gsmAmbiguityHint(current.products, '180gsm tshirt catalogue with prices please')
assert.match(scoped, /bulk \(10\+ total pcs\) ₹211–₹251 per piece/)
assert.match(scoped, /sample \(under 10 total pcs\) ₹277–₹299 per piece/)
assert.match(scoped, /bulk \(10\+ total pcs\) ₹313 per piece/)
assert.match(scoped, /range across catalogue colours\/sizes/)
assert.doesNotMatch(scoped, /₹150\b|₹142\b|₹177\b|\(bulk ₹211\)/)
assert.equal(gsmAmbiguityHint(current.products, 'Black XXL round neck 180gsm price for 2 pcs'), null)
for (const range of [[251, 211], [211], [NaN, 251], [0, 251], ['211', 251]]) {
  const invalid = current.products.map(p => ({ ...p, bulkRange: range, sampleRange: null }))
  assert.doesNotMatch(gsmAmbiguityHint(invalid, '180gsm price'), /₹\d/)
}
console.log('PASS current colour/size extremes, sample scope, fixed-rate neighbour, explicit variant and invalid-range controls')
const request = { products: current.products, buyerText: '180gsm tshirt catalogue price share kijiye', reply: 'Regular ₹211, oversize ₹313 sir.' }
assert.match(gsmPriceRangeGuard(request), /Example Round Neck: ₹211–₹251/)
assert.match(gsmPriceRangeGuard(request), /bulk \(10\+ total pcs\), colour\/size ke hisaab se/)
assert.match(gsmPriceRangeGuard({ ...request, english: true }), /Which product sir\?/)
for (const buyerText of ['Black XXL round neck 180gsm price', '180gsm price for 2 pcs', '180gsm sample price', '180gsm price and delivery', '180gsm rate and coupon code', '180gsm price and photos', '180gsm price and printing', '180gsm price and address', '180gsm price aur mere kapde phate hue hain', '180gsm 240gsm price', '[Image] 180gsm price']) {
  assert.equal(gsmPriceRangeGuard({ ...request, buyerText }), null)
}
for (const prior of ['Black 46 True Bio', '2 pcs', 'sample rate']) assert.equal(gsmPriceRangeGuard({ ...request, history: [{ buyerMessage: prior }] }), null)
assert.equal(gsmPriceRangeGuard({ ...request, history: [{ deferReason: 'manual_reply', buyerMessage: 'mispaired field', aiReply: 'Black True Bio 46' }] }), null)
assert.equal(gsmPriceRangeGuard({ ...request, reply: '[DEFER]' }), null)
assert.equal(gsmPriceRangeGuard({ ...request, reply: 'Rate ₹211. [DEFER]' }), null)
assert.equal(gsmPriceRangeGuard({ ...request, reply: 'Which fit sir? https://sale91.com/catalog' }), null)
assert.equal(gsmPriceRangeGuard({ ...request, products: P }), null)
console.log('PASS GSM price guard and product, quantity, history, mixed-task, handoff, no-price and unavailable-source controls')
const multiple = { ...request, products: [...current.products,
  { title: 'Oversize 210gsm', gsm: 210, bulkRange: [321, 333] },
  { title: 'Oversize 240gsm', gsm: 240, bulkRange: [341, 353] },
  { title: 'AcidWash Oversize', gsm: 240, bulkRange: [361, 373] },
], buyerText: 'Helo sir 180gsm price wholesale sale aur 210gsm aur 240gsm price bta do bhi' }
const multiReply = gsmPriceRangeGuard(multiple)
assert.match(multiReply, /180gsm — Example Round Neck: ₹211–₹251; Oversize 180gsm: ₹313/)
assert.match(multiReply, /210gsm — Oversize 210gsm: ₹321–₹333/)
assert.match(multiReply, /240gsm — Oversize 240gsm: ₹341–₹353; AcidWash Oversize: ₹361–₹373/)
assert.match(multiReply, /180gsm: Kaunsa product chahiye sir\?/)
assert.match(multiReply, /bulk \(10\+ total pcs\)/)
assert.match(gsmPriceRangeGuard({ ...multiple, buyerText: '180gsm and 240gsm prices please', english: true }), /180gsm: Which product sir\?/)
assert.equal((gsmPriceRangeGuard({ ...multiple, buyerText: '180gsm and 180gsm price' }).match(/Example Round Neck/g) || []).length, 1)
for (const buyerText of ['180gsm 210gsm 240gsm 300gsm prices', '180gsm 300gsm price', '180gsm 240gsm sample price', '180gsm 240gsm 20 pcs price', '180gsm 240gsm oversize price', '180gsm 240gsm price and delivery', '180gsm 240gsm price and fabric', '180gsm 240gsm price wrong', '210gsm 240gsm price']) assert.equal(gsmPriceRangeGuard({ ...multiple, buyerText }), null)
for (const extra of [{ imageUrl: 'https://media.invalid/product.jpg' }, { reply: '₹211. [DEFER]' }, { reply: 'Which fit sir?' }, { history: [{ buyerMessage: 'regular fit please' }] }, { history: [{ deferReason: 'manual_reply', aiReply: '2 pcs sample' }] }, { products: multiple.products.filter(p => p.gsm !== 210) }, { products: multiple.products.map(p => p.gsm === 210 ? { ...p, bulkRange: [333, 321] } : p) }]) assert.equal(gsmPriceRangeGuard({ ...multiple, ...extra }), null)
console.log('PASS bounded multiple GSM requests preserve every requested group, fit choice, full ranges and exception boundaries')
console.log(`\n${pass}/${total} passed`); process.exit(pass === total ? 0 : 1)
