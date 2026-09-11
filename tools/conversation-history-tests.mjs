import assert from 'node:assert/strict'
import { formatConversationHistory, sanitizeConversationMessage } from '../server/process.js'

for (const value of ['Account number 123456789012', 'IFSC TEST0123456', 'Use sample-owner@ybl', 'Login password: sample-login-only', 'OTP 123456', 'UPI PIN: 1234']) {
  assert.equal(sanitizeConversationMessage(value), '[Payment or login details were shared privately; do not repeat credentials]')
}
assert.equal(sanitizeConversationMessage('260gsm oversized ₹195, 10+ pcs'), '260gsm oversized ₹[see CATALOG] 10+ pcs')
assert.equal(sanitizeConversationMessage('Call 7048954134'), 'Call 8368648533')
assert.equal(sanitizeConversationMessage('Use RV-EXAMPLE-TEST'), 'Use [private voucher supplied by Ketu]')
assert.equal(sanitizeConversationMessage('260gsm Oversize Black M'), '260gsm Oversize Black M')
assert.equal(sanitizeConversationMessage('Full address: Example Road, Pincode 110062'), 'Full address: Example Road, Pincode 110062')
assert.equal(sanitizeConversationMessage('Postal PIN code 110062'), 'Postal PIN code 110062')
assert.equal(sanitizeConversationMessage('OTP nahi aa raha'), 'OTP nahi aa raha')
assert.equal(sanitizeConversationMessage('I forgot my password, please help'), 'I forgot my password, please help')
const history = formatConversationHistory([
  { status: 'DEFERRED', buyerMessage: 'Can I pay?', aiReply: 'holding' },
  { status: 'SKIPPED', deferReason: 'manual_reply', buyerMessage: 'wrong paired text', aiReply: 'Account number 123456789012' },
  { status: 'REPLIED', buyerMessage: 'Old price ₹195?', aiReply: 'Old price 195rs' },
])
assert.match(history, /DEFERRED TO KETU/)
assert.match(history, /Ketu \(manual reply\): \[Payment or login details/)
assert.doesNotMatch(history, /wrong paired text|123456789012|195/)
assert.match(history, /current catalog and live stock/)
console.log('18 conversation history safety assertions passed')
