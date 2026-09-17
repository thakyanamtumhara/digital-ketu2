import assert from 'node:assert/strict'
import { isStoreMenuGreeting, isStoreReceiptGreeting } from '../server/store-greeting.js'

const menu = '👋 Welcome to Example Clothing!\n👕 T-Shirts and custom prints\n🧥 Hoodies\n🏫 School Uniforms\n🎉 Festival & Event Wear\nBrowse our catalog and message us your requirements.\nExample Clothing — wear your style!'
const messages = [{ messageType: 'text' }]
let checks = 0
function eq(text, expected, items = messages) { assert.equal(isStoreMenuGreeting(text, items), expected, text); checks++ }
eq(menu, true)
eq(menu.replace('👋 Welcome', 'Hey! 👋 Welcome'), true)
eq(menu.replace('Browse our catalog and message us your requirements.', 'ನಿಮ್ಮ requirement ನಮಗೆ message ಮಾಡಿ.\n🛍️ ನಮ್ಮ Catalog check ಮಾಡಿ.'), true)
eq(menu.replaceAll('\n', '\r\n'), true)
for (const ask of ['I need plain tees', 'We want blanks', 'Please send rates', '240gsm', 'What is the MOQ?', 'Samples please', 'delivery to Pune', 'My order', 'custom colour chahiye', 'paid already', 'refund', 'supplier partnership', 'manufacturing enquiry', 'Interested in buying', 'Black size M', 'Is it available？', 'Available؟']) eq(menu + '\n' + ask, false)
for (const text of ['Welcome to Example Clothing!', menu.replace('Browse our catalog', 'See our collection'), menu.replace('Welcome to', 'Hello from'), menu.replace('🧥 Hoodies\n🏫 School Uniforms\n', ''), menu.replaceAll('\n', ' '), menu.repeat(12)]) eq(text, false)
eq(menu, false, [])
for (const messageType of ['image', 'document', 'audio', 'video', 'reaction']) eq(menu, false, [{ messageType: 'text' }, { messageType }])
eq(menu + '\nPremium tees?\nLimited stock!', false)
for (const ask of ['100pcs', 'मुझे चाहिए', 'ನನಗೆ ಬೇಕು', 'مجھے چاہیے', 'আমার চাই']) eq(menu + '\n' + ask, false)
const receipt = "Hi! ✨\nThank you for messaging Example Apparel\nWe've received your message and will get back to you as soon as possible.Feel free to send us a screenshot, product name, or size you're looking for! 📩"
function receiptEq(text, expected, items = messages) { assert.equal(isStoreReceiptGreeting(text, items), expected, text); checks++ }
receiptEq(receipt, true)
receiptEq(receipt.replaceAll("'", '’'), true)
receiptEq(receipt.replace('messaging', 'contacting').replace("We've", 'We have').replace("you're", 'you are'), true)
receiptEq(receipt.replaceAll('\n', '\r\n'), true)
receiptEq(receipt, false, [])
for (const extra of ['What is the price?', 'I need 100 plain tees', 'Please send samples', 'Black M', 'Paid already', 'Return my order', 'मुझे चाहिए', 'Available？', 'Available؟']) {
  receiptEq(receipt + '\n' + extra, false)
  receiptEq(extra + '\n' + receipt, false)
}
for (const text of [receipt.repeat(4), receipt.replace('Example Apparel', 'Example I need shirts'), receipt.replace('as soon as possible.', 'tomorrow.'), receipt.replace('Feel free', 'Please'), receipt.replace('your message', 'your payment'), receipt + '?']) receiptEq(text, false)
for (const messageType of ['image', 'document', 'audio', 'video', 'reaction']) receiptEq(receipt, false, [...messages, { messageType }])
receiptEq(receipt, false, [{ messageType: 'text', mediaUrl: 'https://media.invalid/file' }])
receiptEq(receipt, false, [{ messageType: 'text', hasMedia: true }])
console.log(`${checks} store-greeting checks passed`)
