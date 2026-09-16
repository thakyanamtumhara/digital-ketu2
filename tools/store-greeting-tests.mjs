import assert from 'node:assert/strict'
import { isStoreMenuGreeting } from '../server/store-greeting.js'

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
console.log(`${checks} store-greeting checks passed`)
