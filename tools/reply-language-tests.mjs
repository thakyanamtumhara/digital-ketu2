import assert from 'node:assert/strict'
import { buyerUsesEnglish, repairEnglishReply } from '../server/reply-language.js'

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
const fixed = await repairEnglishReply({ anthropic: client(english), reply: original, buyerText: 'Could I get contact information?' })
assert.equal(fixed.reply, english)
assert.equal(fixed.changed, true)
assert.equal(fixed.costUsd, 0.00025)
for (const output of [english.replace('240', '250'), english.replace('1234567890', '1234567891'), english.replace('/ka/ki', '/new'), '[DEFER]', original, '']) {
  const r = await repairEnglishReply({ anthropic: client(output), reply: original, buyerText: 'Please send details' })
  assert.equal(r.reply, original, 'reject changed facts, action, non-English and empty output')
  assert.equal(r.changed, false)
}
const failed = await repairEnglishReply({ anthropic: { messages: { create: async () => { throw Error('down') } } }, reply: original, buyerText: 'Please send details' })
assert.equal(failed.reply, original)
assert.equal(failed.failed, true)
const before = calls
for (const [reply, buyerText] of [['[DEFER]', 'Please send details'], ['[SKIP]', 'Please send details'], [english, 'Please send details'], [original, 'Number batao']]) {
  const r = await repairEnglishReply({ anthropic: client('should not run'), reply, buyerText })
  assert.equal(r.attempted, false)
  assert.equal(r.reply, reply)
}
assert.equal(calls, before)
console.log(`${cases.length} language decisions and 12 rewrite/control checks passed`)
