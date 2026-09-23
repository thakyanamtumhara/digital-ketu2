import assert from 'node:assert/strict'
import { isStoreMenuGreeting, isStoreReceiptGreeting, isPrintServiceGreeting, isProjectServiceGreeting, isSocialLinksGreeting, isPrintCatalogueGreeting } from '../server/store-greeting.js'

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
const printing = 'Thank you Hello! Thank you for contacting Example Prints 👕 We specialize in custom T-shirt printing. Please share your design, quantity, and T-shirt size. Our team will reply shortly!"'
function printingEq(text, expected, items = messages) { assert.equal(isPrintServiceGreeting(text, items), expected, text); checks++ }
printingEq(printing, true)
printingEq(printing.replace('Thank you Hello! ', ''), true)
printingEq(printing.replace('Thank you Hello!', 'Thanks Hello!').replace('specialize', 'specialise'), true)
printingEq(printing.replaceAll(' ', '\n'), true)
printingEq(printing, true, [{ messageType: 'text' }, { messageType: 'text' }])
for (const extra of ['Can I order a sample?', 'I need plain shirts', 'Please send prices', 'Black M', '100 pcs', 'Please refund my payment.', 'मुझे चाहिए', 'Available？', 'Available؟', '240gsm']) {
  printingEq(printing + '\n' + extra, false)
  printingEq(extra + '\n' + printing, false)
}
for (const text of [printing.repeat(4), printing.replace('Example Prints', 'I need shirts'), printing.replace('Example Prints', 'मुझे चाहिए'), printing.replace('design, quantity, and T-shirt size', 'payment details'), printing.replace('Our team will reply shortly!', 'What is your price?'), printing + '?']) printingEq(text, false)
printingEq(printing, false, [])
for (const messageType of ['image', 'document', 'audio', 'video', 'reaction']) printingEq(printing, false, [...messages, { messageType }])
printingEq(printing, false, [{ messageType: 'text', mediaUrl: 'https://media.invalid/file' }])
printingEq(printing, false, [{ messageType: 'text', hasMedia: true }])
const project = "👋 Hello & Welcome to Example Infrastructure!\n\nThank you for connecting with us. 🙏\nWe're happy to assist you with your project.\n\nPlease share your requirement, size & location, and our team will get back to you with the right solution.\n\nRegards,\nExample Person\nExample Infrastructure\nBuilding Smart. Building Better."
function projectEq(text, expected, items = messages) { assert.equal(isProjectServiceGreeting(text, items), expected, text); checks++ }
projectEq(project, true)
projectEq(project.replaceAll("'", '’'), true)
projectEq(project.replaceAll('\n', '\r\n'), true)
projectEq(project.replaceAll('Example Infrastructure', 'Example Construction'), true)
for (const ask of ['Can I order a sample?', 'I need 100 shirts', 'Price', 'Refund my payment', 'मुझे चाहिए', 'Available？', 'Available؟', '240gsm', 'S M L']) {
  projectEq(project + '\n' + ask, false)
  projectEq(ask + '\n' + project, false)
}
for (const text of [project + '?', '>' + project, project.repeat(3), project.replace('with the right solution.', 'with 100 shirts.'), project.replaceAll('Example Infrastructure', 'I need shirts'), project.replaceAll('Example Infrastructure', 'Example Hoodies'), project.replace('Example Person', 'Refund'), project.replace('Example Person', '100 shirts'), project.replace('Building Better.', 'Buy from you.'), project.replace('Example Person\nExample Infrastructure', 'Example Person\nDifferent Company')]) projectEq(text, false)
projectEq(project, false, [])
for (const messageType of ['image', 'document', 'audio', 'video', 'reaction']) projectEq(project, false, [...messages, { messageType }])
projectEq(project, false, [{ messageType: 'text', hasMedia: true }])
projectEq(project, false, [{ messageType: 'text', mediaUrl: 'https://media.invalid/file' }])
const socials = 'Ty for contacting for more info our socials\nInsta- https://www.instagram.com/example_shop/\nYoutube- https://www.youtube.com/results?search_query=example_shop\nGoogle- https://maps.app.goo.gl/ExampleMap\nWebsite- https://example-shop.my.canva.site/'
function socialEq(text, expected, items = messages) { assert.equal(isSocialLinksGreeting(text, items), expected, text); checks++ }
socialEq(socials, true)
socialEq(socials.replaceAll('\n', '\r\n'), true)
socialEq(socials.replaceAll('\n', ' '), true)
for (const ask of ['Can I order one sample?', 'price', '240gsm', 'Black L', 'refund', 'मुझे चाहिए', '?', '？', '؟']) {
  socialEq(socials + '\n' + ask, false)
  socialEq(ask + '\n' + socials, false)
}
for (const value of ['>' + socials, '"' + socials + '"', socials.repeat(2), socials.replace('my.canva.site/', 'sale91.com/cart'), socials.replace('search_query=example_shop', 'search_query=example_shop&question=sample'), socials.replace('search_query=example_shop', 'search_query=I%20need%20shirts'), socials.replace('www.instagram.com/', 'www.instagram.com.example.net/'), socials.replace('our socials', 'my order'), socials + '?']) socialEq(value, false)
socialEq(socials, false, [])
for (const messageType of ['image', 'document', 'audio', 'video', 'reaction']) socialEq(socials, false, [...messages, { messageType }])
socialEq(socials, false, [{ messageType: 'text', hasMedia: true }])
socialEq(socials, false, [{ messageType: 'text', mediaUrl: 'https://media.invalid/file' }])
const printCatalogue = "Hey! 👋\nWelcome to Example Studio 💛\n\nWe print your mood, memories & story ✨\n\nClothing Catalog 👇\nhttps://tinyurl.com/example-clothes\n\nDiary Collection 👇\nhttps://tinyurl.com/example-diary\n\nPlace your order here 👇\nhttps://forms.gle/ExampleForm\n\nJust send your idea — we'll create it for you 🚀"
function printCatalogueEq(text, expected, items = messages) { assert.equal(isPrintCatalogueGreeting(text, items), expected, text); checks++ }
printCatalogueEq(printCatalogue, true)
printCatalogueEq(printCatalogue.replaceAll("'", '’'), true)
printCatalogueEq(printCatalogue.replaceAll('\n', '\r\n'), true)
printCatalogueEq(printCatalogue.replaceAll('\n', ' '), true)
for (const ask of ['Can I order one sample?', 'price', '240gsm', 'Black L', 'refund', 'मुझे चाहिए', '?', '？', '؟']) {
  printCatalogueEq(printCatalogue + '\n' + ask, false)
  printCatalogueEq(ask + '\n' + printCatalogue, false)
}
for (const value of ['>' + printCatalogue, '"' + printCatalogue + '"', printCatalogue.repeat(2), printCatalogue.replace('Example Studio', 'I need shirts'), printCatalogue.replace('Example Studio', '100 pieces'), printCatalogue.replace('forms.gle/', 'forms.gle.example.net/'), printCatalogue.replace('ExampleForm', 'ExampleForm?question=sample'), printCatalogue.replace('Diary Collection', 'Please send samples'), printCatalogue.replace('tinyurl.com/example-clothes', 'sale91.com/catalog'), printCatalogue.replace('your mood, memories & story', 'my order'), printCatalogue + '?']) printCatalogueEq(value, false)
printCatalogueEq(printCatalogue, false, [])
for (const messageType of ['image', 'document', 'audio', 'video', 'reaction']) printCatalogueEq(printCatalogue, false, [...messages, { messageType }])
printCatalogueEq(printCatalogue, false, [{ messageType: 'text', hasMedia: true }])
printCatalogueEq(printCatalogue, false, [{ messageType: 'text', mediaUrl: 'https://media.invalid/file' }])
console.log(`${checks} store-greeting checks passed`)
