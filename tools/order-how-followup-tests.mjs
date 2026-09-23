import assert from 'node:assert/strict'
import { isOrderHowFollowup } from '../server/order-how-followup.js'

const now = Date.parse('2026-09-23T10:20:00Z')
const last = { buyerMessage: 'Can I order without GST?', aiReply: 'Haan sir, GST ke bina bhi order ho jayega.', createdAt: new Date(now - 60000).toISOString() }
let checks = 0
function check(expected, text, rows = [last]) { assert.equal(isOrderHowFollowup(text, rows, now), expected, text); checks++ }
for (const text of ['Ok sir kese', 'kaise', 'Okay sir how?', 'how sir', 'achha kaise kare']) check(true, text)
for (const text of ['Ok sir', 'thanks', 'kese ho sir', 'how nice', 'Ok sir kese refund milega', '[Image] how', 'order ho gaya', 'how\npayment done']) check(false, text)
check(false, 'how', [])
for (const createdAt of [new Date(now - 7200001).toISOString(), new Date(now + 1000).toISOString(), 'invalid']) check(false, 'how', [{ ...last, createdAt }])
for (const aiReply of ['Ketu will reply shortly sir.', '[DEFER]', 'Payment failed, order online again.', 'Your order dispatched.', 'Hello sir', 'How can I help?']) check(false, 'how', [{ ...last, aiReply }])
for (const buyerMessage of ['Cancel order', 'Refund for my order', 'My parcel is missing', 'Bank payment done']) check(false, 'how', [{ ...last, buyerMessage }])
check(true, 'how', [{ ...last, aiReply: 'You can order without GST sir.' }])
check(true, 'how', [{ ...last, aiReply: 'Website pe order kar dijiye sir.' }])
check(false, 'how', [{ ...last, aiReply: 'Talk to the printer sir.' }, last])
console.log(`${checks} order how-to follow-up checks passed`)
