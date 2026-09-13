import assert from 'node:assert/strict'
import { couponCodeGuard, isConflictingCouponCorrection } from '../server/coupon-code.js'

const history = [{ buyerMessage: 'I need Black tees, 63 pcs', aiReply: 'Please order online.' }]
const guard = (buyerText, extra = {}) => couponCodeGuard({ buyerText, history, reply: 'Fixed price sir.', ...extra })
const cases = [
  ['missing-c code request keeps the latest owner piece promise', () => assert.equal(guard('Kindly send discount ode for hoodie I have to place order', { history: [{ deferReason: 'manual_reply', aiReply: 'Ok. 2 pcs will add' }] }), '[DEFER]')],
  ['owner promise in ordinary English remains an owner task', () => assert.equal(guard('Please give coupon for hoodie', { history: [{ deferReason: 'manual_reply', aiReply: 'I will add 2 pieces.' }] }), '[DEFER]')],
  ['product and ordering words preserve a known-quantity code ask', () => assert.equal(guard('Kindly give discount code for hoodies I have to place order'), '[DEFER]')],
  ['a promise by the model is not owner authorization', () => assert.equal(guard('Send discount ode for hoodie', { history: [{ buyerMessage: 'Hello', aiReply: 'I will add 2 pieces.' }] }), null)],
  ['negated owner promise is not authorization', () => assert.equal(guard('Send discount ode for hoodie', { history: [{ deferReason: 'manual_reply', aiReply: 'I will not add 2 pieces.' }] }), null)],
  ['a newer owner resolution supersedes an earlier promise', () => assert.equal(guard('Send discount ode for hoodie', { history: [{ deferReason: 'manual_reply', aiReply: 'I will add 2 pieces.' }, { deferReason: 'manual_reply', aiReply: 'The replacement is already sent.' }] }), null)],
  ['current refund question is not reduced to coupon issuance', () => assert.equal(guard('Send discount ode for hoodie and refund the delivery fee'), null)],
  ['unrelated ode wording does not trigger a code request', () => assert.equal(guard('Please send an ode for hoodie'), null)],
  ['explicit code request uses the known buyer quantity', () => assert.equal(guard('Please give me a discount code'), '[DEFER]')],
  ['current quantity is sufficient', () => assert.equal(guard('Coupon for my order of 28 pieces please', { history: [] }), '[DEFER]')],
  ['Roman Hindi coupon request', () => assert.equal(guard('Koi coupon hai kya sir'), '[DEFER]')],
  ['large code request still belongs to the owner', () => assert.equal(guard('Promo code for 850 pcs please'), '[DEFER]')],
  ['unknown quantity remains with the normal question path', () => assert.equal(guard('Please give me a coupon', { history: [] }), null)],
  ['assistant offer is not the buyer quantity', () => assert.equal(guard('Please give me a coupon', { history: [{ buyerMessage: 'Hi', aiReply: '1000 pcs has a deal.' }] }), null)],
  ['manual log buyer field is not authentic quantity evidence', () => assert.equal(guard('Please give me a coupon', { history: [{ buyerMessage: '63 pcs', deferReason: 'manual_reply' }] }), null)],
  ['GSM and sizes do not establish a piece count', () => assert.equal(guard('Please give me a coupon', { history: [{ buyerMessage: '260 gsm size 42' }] }), null)],
  ['a price is not the order count', () => assert.equal(guard('Please give me a coupon', { history: [{ buyerMessage: 'Is it 195/pc?' }] }), null)],
  ['plain price negotiation keeps its own policy', () => assert.equal(guard('63 pcs, best price please'), null)],
  ['automatic website discount question is separate', () => assert.equal(guard('Why is the discount not applying to 1000 pcs?'), null)],
  ['coupon application instructions remain answerable', () => assert.equal(guard('Where do I enter my coupon code?'), null)],
  ['failed existing code keeps its troubleshooting path', () => assert.equal(guard('My discount code is not working'), null)],
  ['a code from a refund is not a new coupon request', () => assert.equal(guard('Please refund my order using a coupon'), null)],
  ['OTP code is not a coupon request', () => assert.equal(guard('Please send the login code'), null)],
  ['mixed catalogue and coupon asks stay in the partial-answer path', () => assert.equal(guard('Send hoodie photos and a coupon please'), null)],
  ['current quantity uncertainty is not overridden', () => assert.equal(guard('I am not sure how many pieces, can I have a coupon?'), null)],
  ['existing full handoff is retained', () => assert.equal(guard('Please send a coupon', { reply: '[DEFER]' }), null)],
  ['existing partial handoff is retained', () => assert.equal(guard('Please send a coupon', { reply: 'The catalogue is here. [DEFER]' }), null)],
]
const correction = (buyer, answer, extra = {}) => ({ source: 'CORRECTION', content: `Buyer: ${buyer}\nCorrect reply: ${answer}`, ...extra })
cases.push(
  ['retired coupon refusal is excluded from reusable context', () => assert.equal(isConflictingCouponCorrection(correction('Please provide a coupon code for my 42 pieces', 'Fixed price sir. We work with tight margin')), true)],
  ['retired manual-code ban is excluded from reusable context', () => assert.equal(isConflictingCouponCorrection(correction('Discount code de do bhai', 'Website pe hai , jo bhi hai sir. Manually nothing allowed now sir')), true)],
  ['a general no-coupon answer is not a standing instruction', () => assert.equal(isConflictingCouponCorrection(correction('Any coupon?', 'No coupon code available sir')), true)],
  ['ordinary bargaining correction remains usable', () => assert.equal(isConflictingCouponCorrection(correction('Any discount for 42 pieces?', 'Fixed price sir. We work with tight margin')), false)],
  ['existing code application remains usable', () => assert.equal(isConflictingCouponCorrection(correction('Where do I enter my coupon code?', 'Enter it at checkout.')), false)],
  ['owner handoff beside a price statement remains usable', () => assert.equal(isConflictingCouponCorrection(correction('Any coupon?', 'Fixed price sir. Ketu will send a code.')), false)],
  ['personal refusal is not rewritten into general coupon policy', () => assert.equal(isConflictingCouponCorrection(correction('Any coupon?', 'No coupon for this order because the replacement is already sent.')), false)],
  ['saved ordinary bargaining template remains usable', () => assert.equal(isConflictingCouponCorrection(correction('Any coupon?', 'Fixed price sir.', { source: 'SAVED_REPLY' })), false)],
  ['unpaired source text is preserved', () => assert.equal(isConflictingCouponCorrection({ source: 'CORRECTION', content: 'Any coupon? Fixed price sir.' }), false)],
  ['metadata correction answer takes precedence', () => assert.equal(isConflictingCouponCorrection(correction('Any coupon?', 'Fixed price sir.', { metadata: { correctReply: 'How many pieces in total?' } })), false)],
)
for (const [name, test] of cases) { test(); console.log(`PASS ${name}`) }
console.log(`${cases.length}/${cases.length} coupon-code checks passed`)
