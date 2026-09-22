import assert from 'node:assert/strict'
import { discountTroubleVideoGuard } from '../server/discount-trouble-video.js'

const buyerText = 'The website gives no discount of 4 rupees when I order 20pcs and 5pcs. True bio rneck'
const reply = 'Discount applies from the website in multiples of 10 per size sir — 10, 20, 30 and so on 👉 https://sale91.com'
const english = true
const expected = 'Please watch this video sir 👉 https://youtube.com/shorts/dnFWXQW5yqk'
let checks = 0
function check(input, want) {
  assert.equal(discountTroubleVideoGuard({ buyerText, reply, english, ...input }), want)
  checks++
}
check({}, expected)
check({ buyerText: '4rs discount kyu nhi aa rha order pr', english: false, reply: 'Har size 10 ke multiple mein rakhiye sir — tabhi ₹4 lagega' }, 'Ye video dekh lijiye sir 👉 https://youtube.com/shorts/dnFWXQW5yqk')
check({ buyerText: 'The ₹4 discount is not applying' }, expected)
check({ buyerText: 'There is no discount of 4 taka on my website order' }, expected)
check({ buyerText: '4 rupees discount nahi mil raha' }, expected)
check({ reply: 'Discount ke liye har size multiple of 10 mein lijiye sir — 20 ya 30 pcs, tabhi ₹4/pc lagta hai 👉 https://youtube.com/shorts/dnFWXQW5yqk' }, expected)
for (const text of [
  '20 pcs discount do', 'Give me 4 rupees discount', 'Can you offer 4 rupees discount?',
  '900 pcs best price?', 'No discount of 2 rupees', 'The 4 rupee coupon code is not applying',
  'The 4 rupee discount is not applying and I need a refund',
  'The 4 rupee discount is not applying and Black is out of stock',
  'The 4 rupee discount is not applying. I already watched the video',
  'The 4 rupee discount is still not applying',
]) check({ buyerText: text }, null)
check({ imageUrl: 'https://media.invalid/cart.jpg' }, null)
check({ history: [{ aiReply: expected }] }, null)
check({ reply: '[DEFER]' }, null)
check({ reply: 'Website applies discount in multiples of 10 per size. [DEFER]' }, null)
check({ reply: expected }, null)
check({ reply: reply + ' Cotton fabric.' }, null)
check({ reply: reply + ' It is 180gsm.' }, null)
check({ reply: reply + ' Pickup is ready.' }, null)
check({ reply: reply + ' Available sizes are S to XL.' }, null)
check({ reply: reply + ' Unrecognized independent answer.' }, null)
check({ reply: '' }, null)
console.log(`${checks}/${checks} discount trouble video checks passed`)
