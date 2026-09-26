import assert from 'node:assert/strict'
import { isOrderHowFollowup, isOrderLinkFollowup } from '../server/order-how-followup.js'

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
const shop = { buyerMessage: 'Shipping charge?', aiReply: 'Calculate here https://www.bulkplaintshirt.com/calculation.html', createdAt: new Date(now - 60000).toISOString() }
function linkCheck(expected, text, rows = [shop]) { assert.equal(isOrderLinkFollowup(text, rows, now), expected, text); checks++ }
for (const text of ['Yes I will order. Send me the link please', 'Yeah I will buy give me a website link', 'I want to buy, please share the website link', 'Okay I would like to order. Give me a link sir']) linkCheck(true, text)
for (const text of ['Yes I will order', 'Give me link', 'I will order give me tracking link', 'I will order send payment link', 'I will order give me link refund pending', '[Image] I will order give me link', 'I already ordered give me link', 'I will order give me link https://example.com']) linkCheck(false, text)
for (const createdAt of [new Date(now - 7200001).toISOString(), new Date(now + 1000).toISOString(), 'invalid']) linkCheck(false, 'I will order give me link', [{ ...shop, createdAt }])
for (const aiReply of ['Ketu will reply shortly sir', 'Your parcel https://sale91.com/trq', 'https://sale91.com.evil.test', 'Here https://example.com', 'Paid order https://sale91.com']) linkCheck(false, 'I will order give me link', [{ ...shop, aiReply }])
linkCheck(false, 'I will order give me link', [])
console.log(`${checks} ordering follow-up checks passed`)
