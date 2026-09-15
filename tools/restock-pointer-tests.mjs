import assert from 'node:assert/strict'
import { restockPointerGuard } from '../server/restock-pointer.js'

const now = Date.parse('2026-09-12T12:00:00Z')
const previous = { buyerMessage: 'When will Black M acid wash be back?', aiReply: 'Black M is out of stock sir — check Coming Soon here: https://www.bulkplaintshirt.com/delhi-stock.html', status: 'REPLIED', createdAt: '2026-09-12T11:55:00Z' }
const pointer = 'Coming Soon tab mein update aata rehta hai sir, wahin check karte rahiye 🙏'
const guard = (buyerText, extra = {}) => restockPointerGuard({ buyerText, history: [previous], reply: pointer, now, ...extra })
const cases = [
  ['missing product on the timing page hands off a no-shipment echo', () => assert.equal(guard('Isme toh acid wash nahi hai', { reply: 'Acid wash uss page pe abhi list nahi hai sir, Black M ka koi shipment nahi hai, jo available hai wo le lijiye.' }), '[DEFER]')],
  ['bare earlier question can retain the product named by its answer', () => assert.equal(guard('Isme acid wash nahi hai', { history: [{ ...previous, buyerMessage: 'Restock kab hoga?', aiReply: 'Acid wash Black M ka koi shipment nahi hai, Coming Soon check kar lijiye.' }], reply: 'Acid wash Black M ka koi shipment nahi hai sir.' }), '[DEFER]')],
  ['restock request after a no-date answer hands off without another pointer', () => assert.equal(guard('Abhi mangwa sakte hai kya?', { history: [{ ...previous, aiReply: 'Acid wash Black M ka koi shipment nahi hai sir.' }], reply: 'Abhi nahi bata sakta sir, acid wash Black M ka koi shipment nahi hai.' }), '[DEFER]')],
  ['English no-date repetition hands off', () => assert.equal(guard('When will Black M acid wash restock?', { reply: 'No known shipment date for Black M acid wash yet sir.' }), '[DEFER]')],
  ['first no-shipment answer stays with normal policy', () => assert.equal(guard('Acid wash kab aayega?', { history: [], reply: 'Acid wash Black M ka koi shipment nahi hai.' }), null)],
  ['new exact availability alongside missing timing is preserved', () => assert.equal(guard('When will acid wash restock?', { reply: 'No shipment for Black M, Black XL is available now.' }), null)],
  ['new colour in a no-date answer remains outside the old question', () => assert.equal(guard('When will acid wash restock?', { reply: 'No shipment for White M acid wash.' }), null)],
  ['new size in a no-date answer remains outside the old question', () => assert.equal(guard('When will acid wash restock?', { reply: 'No shipment for Black XL acid wash.' }), null)],
  ['no-date answer about another product is preserved', () => assert.equal(guard('When will acid wash restock?', { reply: 'No shipment for Black M Cotton Polo.' }), null)],
  ['mixed pricing answer is not discarded', () => assert.equal(guard('When will acid wash restock?', { reply: 'No shipment for Black M acid wash; its price is in the catalog.' }), null)],
  ['question asking which variant is preserved', () => assert.equal(guard('When will acid wash restock?', { reply: 'No date sir. Which colour do you need?' }), null)],
  ['fresh estimate alongside a no-shipment statement is preserved', () => assert.equal(guard('When will acid wash restock?', { reply: 'No shipment yet, Black M acid wash should arrive in 3 days.' }), null)],
  ['ambiguous buyer product cannot be resolved solely from the assistant', () => assert.equal(guard('When will polo restock?', { history: [{ ...previous, buyerMessage: 'When will polo restock?', aiReply: 'Cotton Polo Black M has no date, check Coming Soon.' }], reply: 'No date for Cotton Polo Black M yet.' }), null)],
  ['owner answer ends a no-date chain', () => assert.equal(guard('Abhi mangwa sakte hai kya?', { history: [{ ...previous, deferReason: 'manual_reply' }], reply: 'Acid wash Black M ka koi shipment nahi hai.' }), null)],
  ['existing partial handoff is preserved after a missing-page question', () => assert.equal(guard('Isme acid wash nahi hai', { reply: 'No date for Black M acid wash. [DEFER]' }), null)],
  ['same product repeats timing after a no-date pointer', () => assert.equal(guard('Acid wash ka stock kab refill hoga uski koi information nahi h sir'), '[DEFER]')],
  ['English missing-information follow-up retains subject', () => assert.equal(guard('There is no information there'), '[DEFER]')],
  ['same colour and size remain unresolved', () => assert.equal(guard('When will Black M acid wash restock?'), '[DEFER]')],
  ['English pointer repetition is blocked', () => assert.equal(guard('When will acid wash restock?', { reply: 'Please keep checking the Coming Soon section for updates sir.' }), '[DEFER]')],
  ['first timing question keeps its pointer', () => assert.equal(guard('When will acid wash restock?', { history: [] }), null)],
  ['fresh matching date remains answerable', () => assert.equal(guard('When will acid wash restock?', { reply: 'Black M acid wash is arriving in 4 days sir; see Coming Soon.' }), null)],
  ['fresh in-stock answer remains answerable', () => assert.equal(guard('When will acid wash restock?', { reply: 'Black M acid wash is available now sir, you can order it.' }), null)],
  ['new product is not the previous unresolved question', () => assert.equal(guard('When will Cotton Polo restock?'), null)],
  ['new colour is not the same stock question', () => assert.equal(guard('When will White M acid wash restock?'), null)],
  ['new size is not the same stock question', () => assert.equal(guard('When will Black XL acid wash restock?'), null)],
  ['ambiguous named product stays with the model', () => assert.equal(guard('When will polo restock?'), null)],
  ['ambiguous previous product cannot establish a match', () => assert.equal(guard('When will polo restock?', { history: [{ ...previous, buyerMessage: 'When will polo be back?' }] }), null)],
  ['manual source is not an assistant pointer', () => assert.equal(guard('When will acid wash restock?', { history: [{ ...previous, deferReason: 'manual_reply' }] }), null)],
  ['later owner answer ends the unresolved pointer', () => assert.equal(guard('When will acid wash restock?', { history: [previous, { ...previous, status: 'SKIPPED', deferReason: 'manual_reply', aiReply: 'Checking.' }] }), null)],
  ['stale pointer cannot establish the current thread', () => assert.equal(guard('When will acid wash restock?', { history: [{ ...previous, createdAt: '2026-09-11T11:55:00Z' }] }), null)],
  ['missing time is unverified', () => assert.equal(guard('When will acid wash restock?', { history: [{ ...previous, createdAt: null }] }), null)],
  ['previous actual estimate retains its own handling', () => assert.equal(guard('When will acid wash restock?', { history: [{ ...previous, aiReply: 'Black M should arrive in 4 days; check Coming Soon.' }] }), null)],
  ['mixed photo and timing question preserves its independent answer', () => assert.equal(guard('When will acid wash restock, and send hoodie photos?'), null)],
  ['answer plus existing handoff is preserved', () => assert.equal(guard('When will acid wash restock?', { reply: 'Coming Soon has no date. [DEFER]' }), null)],
  ['contact request remains a separate question', () => assert.equal(guard('Owner ka contact number share kro'), null)],
  ['alternative-product answer is not a pure repeated pointer', () => assert.equal(guard('When will acid wash restock?', { reply: 'Check Coming Soon; Brown L is available meanwhile.' }), null)],
]
for (const [name, test] of cases) { test(); console.log(`PASS ${name}`) }
console.log(`${cases.length}/${cases.length} restock-pointer checks passed`)
