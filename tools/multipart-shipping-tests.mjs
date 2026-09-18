import assert from 'node:assert/strict'
import { multipartShippingGuard } from '../server/multipart-shipping.js'

const buyerText = 'Please share details for oversize tees:\nSizes and colours\nBulk price and MOQ\nFabric composition and photos\nShipping details'
const reply = 'Oversize tees, cotton fabric. Current prices and photos 👉 https://sale91.com/catalog/p/oversize-210gsm'
const input = { buyerText, reply, english: true }
const fixed = multipartShippingGuard(input)
assert.ok(fixed.startsWith(reply + '\n'))
assert.match(fixed, /Shipping options and charges show at checkout/)
assert.match(fixed, /\/calc\/shipping-calculator\.html/)
assert.doesNotMatch(fixed, /\d+\s*(?:days?|hours?|₹)/)
let count = 4
for (const [name, changes] of [
  ['single topic', { buyerText: 'Shipping details please' }],
  ['no shipping ask', { buyerText: buyerText.replace('Shipping details', 'Size chart please') }],
  ['existing shipping answer', { reply: reply + ' Shipping costs show at checkout.' }],
  ['owner handoff', { reply: '[DEFER]' }],
  ['partial handoff', { reply: reply + '\n[DEFER]' }],
  ['complaint', { buyerText: buyerText + '\nThe last order was damaged.' }],
  ['payment issue', { buyerText: buyerText + '\nPayment not updated.' }],
  ['printer service', { buyerText: buyerText + '\nCan the printer ship it?' }],
  ['custom task', { buyerText: buyerText + '\nCustom packaging please.' }],
  ['export', { buyerText: buyerText + '\nInternational shipping please.' }],
  ['current photo', { imageUrl: 'https://media.invalid/product.jpg' }],
  ['missing photo', { buyerText: buyerText + '\n[Image]' }],
  ['other language', { english: false }],
  ['clarification', { reply: 'Which product do you need sir?' }],
  ['bare catalog', { reply: 'https://sale91.com/catalog' }],
  ['timing question', { buyerText: buyerText.replace('Shipping details', 'Delivery tomorrow?') }],
  ['already fixed', { reply: fixed }],
]) {
  assert.equal(multipartShippingGuard({ ...input, ...changes }), null, name)
  count++
}
for (const line of ['Delivery/shipping details', 'Shipping / delivery details', '- Shipping cost', '4. Delivery options', 'Shipping and delivery charges']) {
  assert.ok(multipartShippingGuard({ ...input, buyerText: buyerText.replace('Shipping details', line) }), line)
  count++
}
console.log(`${count} multipart shipping checks passed`)
