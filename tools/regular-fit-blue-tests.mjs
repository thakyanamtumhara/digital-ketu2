import assert from 'node:assert/strict'
import { regularFitBlueGuard, regularFitBlueHint } from '../server/regular-fit-blue.js'

const product = { slug: 'true-biowash-round-neck', title: 'True Bio Rneck', gsm: 180, fit: 'regular', colors: ['Black', 'White', 'Navy', 'Royal Blue', 'Sky', 'Red'], bulkRange: [137, 149] }
const products = [product]
const buyerText = 'Hello 180gsm T-shirt 4 blue colour small size\nRegular fit Price ?'
const reply = '180gsm regular fit mein blue nahi hai sir — True Bio mein Navy, Royal Blue, Sky hai, ₹158 sample / ₹137 bulk. Small size ke liye size chart dekhiye; 4 pcs total chahiye?'
const base = { products, buyerText, reply }
const guard = extra => regularFitBlueGuard({ ...base, ...extra })
const hint = extra => regularFitBlueHint({ ...base, ...extra })
const now = Date.now()
const history = [{ buyerMessage: '180gsm regular fit chahiye', aiReply: 'Which colour sir?', status: 'REPLIED', createdAt: new Date(now - 60000).toISOString() }]
let checks = 0
function eq(actual, expected, name) { assert.equal(actual, expected, name); checks++ }
function ok(actual, name) { assert.ok(actual, name); checks++ }

const fixed = guard()
ok(fixed.startsWith('Haan sir, True Bio 180gsm regular fit mein Navy, Royal Blue, Sky aate hain.'), 'false opening becomes a concise yes-first catalogue fact')
ok(!fixed.includes('blue nahi'), 'contradiction removed')
ok(fixed.endsWith('₹158 sample / ₹137 bulk. Small size ke liye size chart dekhiye; 4 pcs total chahiye?'), 'prices, size and quantity question preserved')
eq((fixed.match(/Navy/g) || []).length, 1, 'source shades stated once')
ok(hint().includes('Navy / Royal Blue / Sky'), 'hint uses actual blue shades')
ok(hint().includes('NOT proof of live stock'), 'hint separates catalogue and inventory')
ok(hint().includes('Do not infer an order quantity'), 'hint does not treat stray four as quantity')
ok(guard({ english: true }).startsWith('Yes sir, True Bio is 180gsm regular fit and comes in Navy, Royal Blue, Sky.'), 'English guard wording')
ok(guard({ buyerText: 'True Bio blue colour price?', reply: 'True Bio mein blue nahi hai sir.' }).includes('Navy, Royal Blue, Sky'), 'explicit True Bio request')
ok(guard({ reply: '180gsm regular fit blue is not offered sir. Size chart https://example.com/sizes' }).endsWith('Size chart https://example.com/sizes'), 'English generic catalogue denial')
ok(hint({ buyerText: 'Blue small price?', history, now }), 'fresh explicit buyer context can supply scope')
ok(guard({ buyerText: 'Blue small price?', history, now }), 'guard shares fresh buyer scope')
eq(hint({ buyerText: '180gsm blue colour price?' }), null, 'GSM alone never supplies fit')
eq(hint({ buyerText: 'Blue colour price?' }), null, 'generic blue without product scope stays unresolved')
eq(hint({ buyerText: 'Blue price?', history: [{ ...history[0], buyerMessage: 'Tshirt chahiye', aiReply: '180gsm regular fit chahiye?' }], now }), null, 'assistant statement never supplies product scope')
eq(hint({ buyerText: 'Blue price?', history: [{ ...history[0], createdAt: new Date(now - 7 * 3600000).toISOString() }], now }), null, 'old buyer context cannot supply scope')
eq(hint({ buyerText: 'Blue price?', history: [{ ...history[0], createdAt: null }], now }), null, 'missing history time is not fresh')
eq(hint({ buyerText: 'Blue price?', history: [{ ...history[0], deferReason: 'manual_reply' }], now }), null, 'manual history row is not buyer scope')
eq(hint({ buyerText: 'Blue price?', history: [...history, { ...history[0], buyerMessage: 'Kids tshirt chahiye' }], now }), null, 'new product ends earlier scope')
eq(hint({ buyerText: 'Blue small price?', history: [{ ...history[0], buyerMessage: 'True Bio Navy blue 38 price?' }], now }), null, 'exact previous shade is not broadened to the family')
eq(guard({ buyerText: 'Blue small price?', history: [{ ...history[0], buyerMessage: 'True Bio Navy blue 38 price?' }], now }), null, 'guard preserves the exact previous shade scope')
eq(hint({ buyerText: 'True Bio blue wrong colour received' }), null, 'complaint is not a shopping colour selection')
eq(guard({ buyerText: 'True Bio blue wrong colour received' }), null, 'complaint answer remains untouched')
eq(hint({ buyerText: 'Blue small price?', history: [{ ...history[0], buyerMessage: 'True Bio exact blue price?' }], now }), null, 'exact literal shade history remains exact')

for (const text of ['True Bio exact blue colour?', '180gsm regular fit same blue?', 'True Bio only plain blue price?', 'True Bio blue only?', 'True Bio blue exact shade?', '180gsm regular fit blue same as this photo?', 'True Bio photo wala blue?', 'True Bio blue match the picture', '[Image] True Bio blue colour?', 'True Bio 190gsm blue?', '190gsm regular fit blue?', '180gsm regular fit and 190gsm blue?', 'True Bio 185.5gsm blue?']) {
  eq(hint({ buyerText: text, history, now }), null, 'literal shade, photo match or different GSM: ' + text)
  eq(guard({ buyerText: text, history, now }), null, 'guard preserves literal shade, photo match or different GSM: ' + text)
}
ok(hint({ buyerText: 'True Bio blue colour photos bhejo' }), 'generic photo request is not an exact photo match')
ok(hint({ buyerText: '180gsm regular fit blue 240 pcs price?' }), 'piece quantity is not mistaken for a different GSM')

for (const text of ['180gsm regular fit blue stock mein hai?', '180gsm regular fit blue abhi available hai?', 'True Bio blue currently available?', 'True Bio blue available now?', '180gsm regular fit blue restock kab?', 'True Bio blue aaj milega?']) {
  ok(hint({ buyerText: text }), 'catalogue hint can clarify stock question: ' + text)
  eq(guard({ buyerText: text }), null, 'explicit live stock question keeps its denial: ' + text)
}
for (const text of ['Blue hai?', 'Blue available?', 'Blue small?']) {
  const stockHistory = [{ ...history[0], buyerMessage: '180gsm regular fit abhi stock mein hai?' }]
  ok(hint({ buyerText: text, history: stockHistory, now }), 'stock follow-up still gets catalogue distinction')
  eq(guard({ buyerText: text, history: stockHistory, now }), null, 'immediate stock follow-up denial stays untouched')
}
ok(guard({ buyerText: '180gsm regular fit blue available hai?' }), 'generic availability without current-stock marker still repairs the catalogue contradiction')
for (const text of ['180gsm regular fit blue, not True Bio', '180gsm regular fit blue except True Bio', '180gsm regular fit blue without True Bio', "180gsm regular fit blue, I don't want True Bio", '180gsm regular fit blue, True Bio nahi chahiye', 'True Bio blue not regular fit', 'True Bio blue not a regular fit', '180gsm blue regular fit nahi chahiye', 'True Bio 180gsm regular fit, not blue', 'True Bio blue nahi chahiye', 'True Bio blue mat dena']) {
  eq(hint({ buyerText: text }), null, 'excluded entity is not the request: ' + text)
  eq(guard({ buyerText: text }), null, 'excluded entity keeps the original reply: ' + text)
}
eq(hint({ buyerText: 'Blue price?', history: [{ ...history[0], buyerMessage: '180gsm regular fit, not True Bio' }], now }), null, 'excluded historical product never establishes scope')

for (const text of ['180gsm Oversize blue price?', '180gsm regular fit and Oversize blue price?', 'Kids blue colour?', 'Non Bio 180gsm regular fit blue colour?', 'Bio wash 180gsm regular fit blue?', 'Cotton polo blue price?', 'True Bio Navy blue price?', '180gsm regular fit Royal Blue S available?', 'True Bio Sky blue?', '180gsm regular fit powder blue?', '180gsm regular fit light blue?', '240gsm regular fit blue?', 'True Bio 240gsm blue?']) {
  eq(hint({ buyerText: text, history, now }), null, 'explicit other product/shade: ' + text)
  eq(guard({ buyerText: text, history, now }), null, 'guard preserves other product/shade: ' + text)
}

for (const output of ['[DEFER]', '[SKIP]', 'Blue price is here [DEFER]', '180gsm regular fit blue abhi nahi hai sir.', '180gsm regular fit blue is out of stock sir.', '180gsm regular fit blue small size nahi hai sir.', 'True Bio blue size 38 nahi hai sir.', 'True Bio Navy blue nahi hai sir.', '180gsm regular fit blue is not available currently.', '180gsm regular fit blue nahi hai sir, small size out of stock.', '180gsm regular fit blue shades Navy, Royal Blue, Sky hain sir.', 'Oversize 180gsm mein blue nahi hai sir.', '180gsm regular fit mein blue nahi hai sir; stock aaj khatam hua hai.', 'Blue nahi hai sir.']) {
  eq(guard({ reply: output }), null, 'unrelated/temporary/size denial: ' + output)
}

for (const data of [[], [product, product], [{ ...product, fit: null }], [{ ...product, fit: 'oversize' }], [{ ...product, gsm: 210 }], [{ ...product, colors: [] }], [{ ...product, colors: ['Black', 'White'] }], [{ ...product, colors: ['Navy', 42] }]]) {
  eq(hint({ products: data }), null, 'unverified source has no hint')
  eq(guard({ products: data }), null, 'unverified source has no guard')
}
const changed = [{ ...product, colors: ['Black', 'Navy'] }]
ok(hint({ products: changed }).includes('shades are Navy.'), 'changed catalogue controls hint')
ok(!guard({ products: changed }).includes('Royal Blue'), 'removed blue shades do not survive repaired listing')
ok(guard({ products: changed }).includes('mein Navy aate hain.'), 'changed catalogue controls guard')
ok(hint({ products: [{ ...product, colors: ['Black', 'Blue'] }] }).includes('shades are Blue.'), 'literal Blue supported when actually offered')
ok(!hint({ products: [{ ...product, colors: ['Black', 'Blue'] }] }).includes('Navy'), 'no hardcoded shade expansion')
eq(guard({ reply: fixed }), null, 'corrected reply is stable')
console.log(checks + ' regular-fit blue checks passed')
