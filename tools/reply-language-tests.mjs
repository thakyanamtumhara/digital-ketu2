import assert from 'node:assert/strict'
import { buyerUsesEnglish, buyerUsesRomanHindi, repairReplyLanguage, containsHindi } from '../server/reply-language.js'

const englishHistory = [{ buyerMessage: 'We need some shirts', aiReply: 'Kaunsa product chahiye sir?' }]
const cases = [
  ['short contact request', { buyerText: 'Could I get contact information?' }, true],
  ['two-word request', { buyerText: 'Share contact' }, true],
  ['terse follow-up', { buyerText: 'Heavyweight', history: englishHistory }, true],
  ['unknown first fragment', { buyerText: 'Heavyweight' }, false],
  ['current Hindi wins over inferred history', { buyerText: 'Iska rate batao', history: englishHistory }, false],
  ['latest Hindi history wins', { buyerText: 'Heavyweight', history: [...englishHistory, { buyerMessage: 'Mujhe shirts chahiye' }] }, false],
  ['manual mispair is not buyer speech', { buyerText: 'Heavyweight', history: [{ buyerMessage: 'Please send details', deferReason: 'manual_reply' }] }, false],
  ['assistant language is not buyer speech', { buyerText: 'Heavyweight', history: [{ buyerMessage: 'Polo', aiReply: 'Please send details' }] }, false],
  ['explicit English overrides matching', { buyerText: 'English please', history: [{ buyerMessage: 'Hindi mein batao' }], preferredLanguage: 'hindi' }, true],
  ['explicit Hindi overrides saved English', { buyerText: 'Hindi mein batao', preferredLanguage: 'english' }, false],
  ['saved English preference', { buyerText: 'Price kya hai', preferredLanguage: 'english' }, true],
  ['saved Hindi preference', { buyerText: 'Please send details', preferredLanguage: 'hindi' }, false],
  ['prior explicit English', { buyerText: 'Heavyweight', history: [{ buyerMessage: 'English please' }] }, true],
  ['Devanagari without preference', { buyerText: 'रेट क्या है', history: englishHistory }, false],
  ['other script is not English', { buyerText: 'விலை என்ன', history: englishHistory }, false],
  ['a URL is not language evidence', { buyerText: 'https://example.invalid/please/send/details' }, false],
  ['first location request after an unclassified greeting', { buyerText: 'Location', history: [{ buyerMessage: 'Hlw' }] }, true],
  ['one-word address request', { buyerText: 'Address please' }, true],
  ['single request retains prior buyer Hindi', { buyerText: 'Location', history: [{ buyerMessage: 'Mujhe shirts chahiye' }] }, false],
  ['single request retains explicit Hindi', { buyerText: 'Location', preferredLanguage: 'hindi' }, false],
  ['non-English fragment is not a location request', { buyerText: 'Location batao' }, false],
  ['arbitrary fragment remains unclassified', { buyerText: 'Navy' }, false],
  ['greeting plus misspelled store address', { buyerText: 'Hello store adresss please??' }, true],
  ['greeting plus catalogue request', { buyerText: 'Hey catalogue' }, true],
  ['contact request with shop prefix', { buyerText: 'Hi shop contact pls' }, true],
  ['correctly spelled shop address', { buyerText: 'Store address' }, true],
  ['address typo retains recent Hindi', { buyerText: 'Hi shop adress', history: [{ buyerMessage: 'Mujhe shirts chahiye' }] }, false],
  ['catalogue noun retains explicit Hindi', { buyerText: 'Hello catalogue', preferredLanguage: 'hindi' }, false],
  ['unknown fragment beside location is not English proof', { buyerText: 'Location kudu' }, false],
  ['standalone location after emoji greeting', { buyerText: 'Hi 🙏 shop address??' }, true],
]
for (const [name, context, expected] of cases) assert.equal(buyerUsesEnglish(context), expected, name)

const original = 'Call kar lijiye sir 👉 1234567890 — sample ₹240 👉 https://example.invalid/ka/ki'
const english = 'Please call sir 👉 1234567890 — sample ₹240 👉 https://example.invalid/ka/ki'
let calls = 0
const client = text => ({ messages: { create: async body => {
  calls++
  assert.equal(body.model, 'claude-haiku-4-5-20251001')
  assert.equal(body.max_tokens, 300)
  return { content: [{ type: 'text', text }], usage: { input_tokens: 50, output_tokens: 40 } }
} } })
const fixed = await repairReplyLanguage({ anthropic: client(english), reply: original, buyerText: 'Could I get contact information?' })
assert.equal(fixed.reply, english)
assert.equal(fixed.changed, true)
assert.equal(fixed.costUsd, 0.00025)
for (const output of [english.replace('240', '250'), english.replace('1234567890', '1234567891'), english.replace('/ka/ki', '/new'), '[DEFER]', original, '']) {
  const r = await repairReplyLanguage({ anthropic: client(output), reply: original, buyerText: 'Please send details' })
  assert.equal(r.reply, original, 'reject changed facts, action, non-English and empty output')
  assert.equal(r.changed, false)
}
const failed = await repairReplyLanguage({ anthropic: { messages: { create: async () => { throw Error('down') } } }, reply: original, buyerText: 'Please send details' })
assert.equal(failed.reply, original)
assert.equal(failed.failed, true)
const before = calls
for (const [reply, buyerText] of [['[DEFER]', 'Please send details'], ['[SKIP]', 'Please send details'], [english, 'Please send details'], [original, 'Number batao']]) {
  const r = await repairReplyLanguage({ anthropic: client('should not run'), reply, buyerText })
  assert.equal(r.attempted, false)
  assert.equal(r.reply, reply)
}
assert.equal(calls, before)
console.log(`${cases.length} language decisions and 12 rewrite/control checks passed`)

const namedHindi = "Location pe 'TSHIRT WALA GODAM' poochh lena sir 👉 https://example.invalid/location"
const namedEnglish = "Ask for 'TSHIRT WALA GODAM' when you arrive sir 👉 https://example.invalid/location"
assert.equal(containsHindi(namedEnglish), false)
assert.equal(containsHindi(namedHindi), true)
assert.equal(containsHindi('Yeh wala chahiye sir'), true)
const namedFixed = await repairReplyLanguage({ anthropic: client(namedEnglish), reply: namedHindi, buyerText: 'Please share your address' })
assert.equal(namedFixed.reply, namedEnglish)
assert.equal(namedFixed.changed, true)
const translatedName = await repairReplyLanguage({ anthropic: client(namedEnglish.replace('TSHIRT WALA GODAM', 'TSHIRT WAREHOUSE')), reply: namedHindi, buyerText: 'Please share your address' })
assert.equal(translatedName.changed, false)
assert.equal(translatedName.reply, namedHindi)
const alreadyEnglish = await repairReplyLanguage({ anthropic: client('must not run'), reply: namedEnglish, buyerText: 'Please share your address' })
assert.equal(alreadyEnglish.attempted, false)
console.log('6 proper-name boundary controls passed')

assert.equal(containsHindi('Sizes S se XXL sir'), true)
assert.equal(containsHindi('Sizes 36 se 46 sir'), true)
assert.equal(containsHindi('We deliver to SE Delhi sir'), false)
const sizeRange = await repairReplyLanguage({ anthropic: client('Sizes S to XXL sir'), reply: 'Sizes S se XXL sir', buyerText: 'Please share hoodie details' })
assert.equal(sizeRange.reply, 'Sizes S to XXL sir')
assert.equal(sizeRange.changed, true)
console.log('4 size-range language controls passed')

const romanCases = [
  ['Hindi invoice question over older English', { buyerText: 'Sir invoice download kaise karna hai?', history: englishHistory }, true],
  ['Roman Hindi spelling variants', { buyerText: 'Plain tee chaihay mujay' }, true],
  ['Roman Hindi possession spelling', { buyerText: 'Apnay paas Supima hay ky?' }, true],
  ['current explicit English wins', { buyerText: 'Invoice kaise download hoga, English please' }, false],
  ['saved English remains authoritative', { buyerText: 'Invoice kaise milega?', preferredLanguage: 'english' }, false],
  ['earlier explicit English remains authoritative', { buyerText: 'Invoice kaise milega?', history: [{ buyerMessage: 'English please' }] }, false],
  ['manual text cannot set buyer preference', { buyerText: 'Invoice kaise milega?', history: [{ buyerMessage: 'English please', deferReason: 'manual_reply' }] }, true],
  ['current explicit Hindi overrides saved English', { buyerText: 'Hindi mein batao', preferredLanguage: 'english' }, true],
  ['unclear product noun stays unclassified', { buyerText: 'Polo', history: [{ buyerMessage: 'Mujhe shirt chahiye' }] }, false],
  ['GSM only stays unclassified', { buyerText: '240 GSM' }, false],
  ['English may is not Hindi', { buyerText: 'May I see your cotton shirts?' }, false],
  ['English hay is not Hindi', { buyerText: 'Do you have hay coloured shirts?' }, false],
  ['Devanagari does not become Roman', { buyerText: 'बिल कैसे मिलेगा' }, false],
  ['Tamil stays outside this repair', { buyerText: 'விலை என்ன' }, false],
]
for (const [name, context, expected] of romanCases) assert.equal(buyerUsesRomanHindi(context), expected, name)
assert.equal(buyerUsesEnglish({ buyerText: 'Plain tee chaihay mujay', history: englishHistory }), false)
assert.equal(buyerUsesEnglish({ buyerText: 'Apnay paas Supima hay ky?', history: englishHistory }), false)

const invoiceEnglish = 'Your bills sync once you log in sir 👉 https://example.invalid/login'
const invoiceHindi = 'Login karte hi aapke bills sync ho jayenge sir 👉 https://example.invalid/login'
const invoiceFixed = await repairReplyLanguage({ anthropic: client(invoiceHindi), reply: invoiceEnglish, buyerText: 'Invoice kaise milega?', history: englishHistory })
assert.equal(invoiceFixed.reply, invoiceHindi)
assert.equal(invoiceFixed.target, 'roman_hindi')
assert.equal(invoiceFixed.changed, true)
for (const rewritten of [invoiceEnglish, invoiceHindi.replace('/login', '/pay'), '[DEFER]', 'बिल लॉगिन में है', '']) {
  const r = await repairReplyLanguage({ anthropic: client(rewritten), reply: invoiceEnglish, buyerText: 'Invoice kaise milega?' })
  assert.equal(r.reply, invoiceEnglish, 'reject failed Hindi translation, changed link/action/script')
}
const sizesOriginal = 'We have sizes S to XXL for ₹211 sir 👉 https://example.invalid/product'
const sizesHindi = 'S se XXL sizes ₹211 mein hain sir 👉 https://example.invalid/product'
for (const rewritten of [sizesHindi.replace('XXL', 'XL'), sizesHindi.replace('211', '219')]) {
  const r = await repairReplyLanguage({ anthropic: client(rewritten), reply: sizesOriginal, buyerText: 'Sizes kya hai?' })
  assert.equal(r.reply, sizesOriginal)
}
const romanFailure = await repairReplyLanguage({ anthropic: { messages: { create: async () => { throw Error('down') } } }, reply: invoiceEnglish, buyerText: 'Invoice kaise milega?' })
assert.equal(romanFailure.reply, invoiceEnglish)
assert.equal(romanFailure.failed, true)
for (const [reply, buyerText] of [[invoiceEnglish, '240 GSM'], [invoiceHindi, 'Invoice kaise milega?'], ['[DEFER]', 'Refund kab milega?'], ['[SKIP]', 'Theek hai']]) {
  const r = await repairReplyLanguage({ anthropic: client('must not run'), reply, buyerText })
  assert.equal(r.attempted, false)
}
console.log('14 Roman Hindi decisions and 16 repair/boundary assertions passed')
