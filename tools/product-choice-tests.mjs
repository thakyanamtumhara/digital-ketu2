import assert from 'node:assert/strict'
import { pendingProductChoiceGuard } from '../server/product-choice.js'

const now = Date.parse('2026-09-13T12:00:00Z')
const previous = { status: 'REPLIED', createdAt: new Date(now - 30000).toISOString(), buyerMessage: 'Black tshirt', aiReply: 'Black 180gsm ya 260gsm sir? 👉 https://sale91.com/catalog' }
const base = { now, history: [previous], buyerText: 'Stock kab aayega sir?', reply: '180gsm black 4-5 din mein aayega sir.' }
assert.equal(pendingProductChoiceGuard(base), 'Black 180gsm ya 260gsm sir?')
assert.equal(pendingProductChoiceGuard({ ...base, reply: '4-5 din mein aayega sir.' }), 'Black 180gsm ya 260gsm sir?')
assert.equal(pendingProductChoiceGuard({ ...base, buyerText: 'When will it be back?', history: [{ ...previous, aiReply: 'Black 180gsm or 260gsm sir?' }] }), 'Black 180gsm or 260gsm sir?')
assert.equal(pendingProductChoiceGuard({ ...base, reply: 'Kal aa jayega sir.' }), 'Black 180gsm ya 260gsm sir?')
for (const buyerText of ['260 gsm', '180gsm stock kab aayega?', 'Dono kab aayenge?', 'Second wala kab aayega?', 'Stock kab aayega and price?', '[Image] stock kab aayega', 'Where is my order?', 'Stock kab aayega refund chahiye', 'Red stock kab aayega?', 'Kab aayega 20pc?', 'Coming Soon mein nahi hai', 'Stock kab aayega https://example.invalid']) assert.equal(pendingProductChoiceGuard({ ...base, buyerText }), null, buyerText)
for (const reply of ['[DEFER]', '4 din mein aayega [DEFER]', 'Black 180gsm ya 260gsm sir?', 'Coming Soon tab check kar lijiye.', '180gsm 4 days; 260gsm 6 days.', '240gsm 4 din mein aayega.', '180gsm ₹199, 4 din mein aayega.']) assert.equal(pendingProductChoiceGuard({ ...base, reply }), null, reply)
for (const previousChange of [{ deferReason: 'manual_reply' }, { status: 'DEFERRED' }, { createdAt: 'invalid' }, { createdAt: new Date(now + 1).toISOString() }, { createdAt: new Date(now - 7200001).toISOString() }, { buyerMessage: '180gsm black tshirt' }, { aiReply: 'Black 180gsm ya 180gsm sir?' }, { aiReply: 'Black 180gsm available, ya 260gsm sir?' }, { aiReply: 'Black 180gsm ya 260gsm sir? Refund approved.' }]) assert.equal(pendingProductChoiceGuard({ ...base, history: [{ ...previous, ...previousChange }] }), null, JSON.stringify(previousChange))
assert.equal(pendingProductChoiceGuard({ ...base, history: [] }), null)
assert.equal(pendingProductChoiceGuard({ ...base, history: [previous, { status: 'SKIPPED', deferReason: 'manual_reply', aiReply: '260gsm', createdAt: new Date(now).toISOString() }] }), null)
console.log('PASS unresolved product timing, explicit choices, two-product answers, mixed tasks, media, handoffs and stale-history controls')
