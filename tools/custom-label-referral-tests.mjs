import assert from 'node:assert/strict'
import { customLabelReferralGuard } from '../server/custom-label-referral.js'

const input = { buyerText: 'Could I know minimum quantity for adding our brand labels?', reply: 'We do not do custom labels. See our plain tees.', english: true }
const fixed = customLabelReferralGuard(input)
assert.match(fixed, /plain tees with size labels/)
assert.match(fixed, /independent vendor/)
assert.match(fixed, /https:\/\/wa\.me\/917808284808/)
assert.doesNotMatch(fixed, /\b(?:MOQ|minimum|discount|guarantee)\b/i)
let count = 4
for (const buyerText of ['Hello! What is the MOQ for getting my own tags?', 'Can you stitch my neck labels?', 'I need our brand tags.', 'Could you please add our own custom neck labels?']) {
  assert.ok(customLabelReferralGuard({ ...input, buyerText }), buyerText)
  count++
}
for (const [name, changes] of [
  ['already referred', { reply: fixed }],
  ['other referral needs review', { reply: input.reply + ' https://wa.me/910000000000' }],
  ['ordinary size label', { buyerText: 'What size labels do your tees have?' }],
  ['label colour', { buyerText: 'Which colour label is true bio?' }],
  ['logo printing', { buyerText: 'Can you print my brand logo?' }],
  ['mixed product quote', { buyerText: input.buyerText + ' Also quote the white polo price.' }],
  ['complaint', { buyerText: input.buyerText + ' My last order had wrong labels.' }],
  ['shipping', { buyerText: input.buyerText + ' How soon can you ship?' }],
  ['owner handoff', { reply: '[DEFER]' }],
  ['partial handoff', { reply: input.reply + ' [DEFER]' }],
  ['current image', { imageUrl: 'https://media.invalid/label.jpg' }],
  ['media placeholder', { buyerText: input.buyerText + ' [Image]' }],
  ['non-English', { english: false }],
  ['clarification', { reply: 'Do you mean printed tags or sewn labels?' }],
  ['specific vendor decision', { reply: 'The vendor must confirm label availability.' }],
  ['empty answer', { reply: '' }],
]) {
  assert.equal(customLabelReferralGuard({ ...input, ...changes }), null, name)
  count++
}
console.log(`${count} custom-label referral checks passed`)
