import assert from 'node:assert/strict'
import { couponCodeGuard } from '../server/coupon-code.js'

const history = [{ buyerMessage: 'I need Black tees, 63 pcs', aiReply: 'Please order online.' }]
const guard = (buyerText, extra = {}) => couponCodeGuard({ buyerText, history, reply: 'Fixed price sir.', ...extra })
const cases = [
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
for (const [name, test] of cases) { test(); console.log(`PASS ${name}`) }
console.log(`${cases.length}/${cases.length} coupon-code checks passed`)
