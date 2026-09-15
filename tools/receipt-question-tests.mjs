import assert from 'node:assert/strict'
import { isRecipientReceiptQuestion } from '../server/receipt-question.js'

const cases = [
  ['Bhai parcel mila aapko', true],
  ['Sir aap ko mera parcel mil gaya hai', true],
  ['T-shirts mil gaye aapko?', true],
  ['Did you receive my parcel', true],
  ['Have you received the package back sir?', true],
  ['Has my parcel reached you', true],
  ['Sir, did you get my t-shirt?', true],
  ['Parcel mil gaya mujhe', false],
  ['Mujhe tshirt mil gayi sir', false],
  ['I received my parcel thanks', false],
  ['Sir parcel mil gaya thank you', false],
  ['Thanks sir', false],
  ['Aapko tshirt mil jayega', false],
  ['Stock mil gaya kya', false],
  ['Have you received my payment?', false],
  ['Did you receive my parcel and what is the price?', false],
  ['Sir aapko kya chahiye', false],
  ['', false],
]
for (const [text, expected] of cases) assert.equal(isRecipientReceiptQuestion(text), expected, text)
console.log(`${cases.length} receipt-question checks passed`)
