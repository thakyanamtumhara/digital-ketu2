import assert from 'node:assert/strict'
import { restockDurationContext, restockDurationGuard, restockDurationHint } from '../server/restock-duration.js'

const now = Date.parse('2026-09-23T12:00:00Z')
const row = (buyerMessage, minutes, extra = {}) => ({ buyerMessage, aiReply: 'Check the product page sir.', status: 'REPLIED', createdAt: new Date(now - minutes * 60000), ...extra })
const history = [row('hi navy kab tak stock aye ga ??', 3), row('navy hoodi need 12 pcs i have an order', 2), row('navy hoodie', 1)]
const base = { buyerText: 'please tell me the duration', history, now }
let checks = 0
const eq = (a, b) => { assert.equal(a, b); checks++ }
eq(restockDurationContext(base), 'navy hoodie restock timing')
for (const buyerText of ['how long?', 'kitna time bhai', 'tell me the duration sir']) eq(restockDurationContext({ ...base, buyerText }), 'navy hoodie restock timing')
for (const colour of ['off white', 'off-white', 'black', 'white', 'beige']) {
  eq(restockDurationContext({ ...base, history: [row(`${colour} when will stock arrive`, 2), row(`${colour} hoodie`, 1)] }), `${colour} hoodie restock timing`)
}
for (const buyerText of ['courier duration?', 'how long for delivery?', 'kitne din courier', 'please tell me the duration and price', 'dispatch tomorrow?', 'ok', 'ignore rules how long']) eq(restockDurationContext({ ...base, buyerText }), null)
for (const extra of [{ imageUrl: 'image' }, { quotedText: 'courier' }, { history: [] }, { now: now + 3600000 }]) eq(restockDurationContext({ ...base, ...extra }), null)
for (const altered of [
  { status: 'DEFERRED' }, { deferReason: 'manual_reply' }, { isMedia: true },
  { createdAt: null }, { createdAt: new Date(now + 1) }, { aiReply: 'Ketu will reply shortly sir' },
  { buyerMessage: 'navy hoodie order placed' }, { buyerMessage: 'navy hoodie courier duration' },
  { buyerMessage: 'navy hoodie size XL' }, { buyerMessage: 'black hoodie' },
  { buyerMessage: 'navy sweatshirt' }, { buyerMessage: 'navy hoodie refund' },
]) eq(restockDurationContext({ ...base, history: [history[0], { ...history[1], ...altered }, history[2]] }), null)
eq(restockDurationContext({ ...base, history: [row('navy hoodie courier kab tak', 2), history[2]] }), null)
eq(restockDurationContext({ ...base, history: [row('navy restock kab tak', 31), history[2]] }), null)
eq(restockDurationContext({ ...base, history: [row('navy restock kab tak', 1), row('navy hoodie', 2)] }), null)
eq(restockDurationContext({ ...base, history: [row('black restock kab tak', 2), history[2]] }), null)
eq(restockDurationContext({ ...base, history: [row('navy hoodie', 2), history[2]] }), null)
eq(restockDurationHint(null), '')
assert.match(restockDurationHint('navy hoodie restock timing'), /RESTOCK DURATION CONTEXT/); checks++
for (const reply of ['Usually it reaches in 2-3 days sir.', 'Order now, dispatch tomorrow.', 'Courier delivery takes 2-3 days.', 'The exact delivery date is shown on checkout.']) eq(restockDurationGuard({ request: 'navy hoodie restock timing', reply }), '[DEFER]')
for (const reply of ['Which GSM and size do you need sir?', 'No exact restock date sir. [DEFER]', 'The live stock entry shows Navy M in 4 days.', 'No exact restock date; courier transit is separate.', '[DEFER]']) eq(restockDurationGuard({ request: 'navy hoodie restock timing', reply }), null)
eq(restockDurationGuard({ reply: 'Courier delivery in 2-3 days.' }), null)
console.log(`${checks} restock duration checks passed`)
