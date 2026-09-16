import assert from 'node:assert/strict'
import { isStockArrivalQuestion, isStockAvailabilityQuestion } from '../server/stock-question.js'
import { learningEligibility } from '../server/learning-candidates.js'

const positives = ['Bhai offwhite aaya?', 'Sir ofwhite aaya ?', 'Grey polo aaya kya', 'Black 240gsm aa gaya?', 'Navy M aayi hai?', 'Premium polo aa gaye kya sir?', 'Off-white abhi tak aaya?']
const negatives = ['Mera black parcel aaya?', 'Black payment aaya?', 'Returned white shirt aaya kya?', 'Sir aaya?', 'Black aa gaya', 'Thanks black aa gaya', 'Black ka rate aaya?', 'Black aaya? refund bhi karna', 'Black aaya?\norder bhejo', 'Black aayega?', 'Navy hoodie print aaya?', 'Sir white aaya? https://example.invalid', 'Sir black aaya? [Image]']
for (const text of positives) {
  assert.equal(isStockArrivalQuestion(text), true, text)
  assert.equal(isStockAvailabilityQuestion(text), true, text)
  assert.equal(learningEligibility({ buyerQuestion: text, correctReply: 'Abhi nahi hai sir' }), 'perishable_stock_answer', text)
}
for (const text of negatives) assert.equal(isStockArrivalQuestion(text), false, text)
assert.equal(learningEligibility({ buyerQuestion: 'Can I mix colours?', correctReply: 'Yes, mix colours freely.' }), null)
assert.equal(learningEligibility({ buyerQuestion: 'Black 240gsm aaya kya?', correctReply: '4 din mein', timed: true }), null)
console.log(`${positives.length + negatives.length + 2} stock-arrival boundaries passed`)
