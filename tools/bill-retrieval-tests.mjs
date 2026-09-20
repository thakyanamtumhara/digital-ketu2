import assert from 'node:assert/strict'
import { billRetrievalGuard } from '../server/bill-retrieval.js'

let checks = 0
const guard = (buyerText, extra = {}) => billRetrievalGuard({ buyerText, reply: '[DEFER]', ...extra })
for (const text of ['Mai bill kaha se nikalu', 'Sir, invoice kahan se download karu?', 'Mujhe bill kidhar milega', 'Bill kaha milega?', 'Main invoice kahan dekhu', 'How do I download my invoice?', 'Where can I find my bill?', 'Please, where should I get the invoice?']) {
  assert.match(guard(text), /https:\/\/sale91\.com\/login/)
  checks++
}
for (const text of ['Bill kaha se nikalu aur GST name change karo', 'Where can I get my invoice and refund?', 'Bill mein GST add karo', 'Bill ka amount galat hai', 'Login kiya phir bhi bill nahi mil raha', 'Where can I find my bill again?', 'Bill kaha milega refund ka', 'Bill nahi mila', 'Send my bill', 'Saare bills aur ledger chahiye', 'Where can I get my bank invoice?', 'Mai bill kaha se nikalu\nOrder damaged hai', '[Image] bill kaha milega', 'Photo mein bill kaha hai', 'Where can I download the invoice for a different company?']) {
  assert.equal(guard(text), null)
  checks++
}
for (const extra of [{ reply: 'Already answered.' }, { reply: 'Part answered.\n[DEFER]' }, { reply: '[SKIP]' }, { imageUrl: 'https://media.invalid/receipt.jpg' }, { history: [{ aiReply: 'See https://sale91.com/login' }] }, { history: [{ aiReply: 'https://www.sale91.com/login?from=chat', deferReason: 'manual_reply' }] }]) {
  assert.equal(guard('Where can I find my bill?', extra), null)
  checks++
}
assert.match(guard('Where can I find my bill?', { english: true }), /^Log in to see and download/)
assert.match(guard('Mai bill kaha se nikalu', { history: [{ buyerMessage: 'Wrong size received', aiReply: 'Ketu will reply shortly sir' }, { deferReason: 'manual_reply', aiReply: 'Share your bill' }] }), /sale91\.com\/login/)
console.log(`${checks + 2} bill retrieval checks passed`)
