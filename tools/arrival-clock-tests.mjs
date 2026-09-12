import assert from 'node:assert/strict'
import { arrivalClockGuard } from '../server/arrival-clock.js'

const buyerText = 'Please deliver my parcel by 4 pm'
for (const reply of [
  'Ok sir, 4 baje tak deliver karva denge 🚚',
  'Parcel 4 baje tak pahunch jayega sir',
  '4 baje tak aa jayega sir',
  'It will be delivered by 4 pm sir.',
  'It should reach by 16:00.',
  'It will arrive by four o’clock.',
  'It will get delivered by 4.30 pm.',
  'चार बजे तक डिलीवर करवा देंगे।',
  'पार्सल ४ बजे तक पहुंच जाएगा।',
  'Sir, parcel 4 baje tak pahunchega.',
  'Delivery confirmed by 4 pm.',
  'Call if needed; it will arrive by 4 pm.',
  "I cannot promise this, but it will arrive by 4 pm.",
  'It will arrive by 4 pm. [DEFER]',
]) assert.match(arrivalClockGuard({ buyerText, reply }), /\[DEFER\]/, reply)

for (const reply of [
  'Delhi bike delivery takes 1-2 hours sir.',
  'Delivery mein 2-3 din lagte hain sir.',
  'Your parcel was delivered at 4 pm.',
  'Your parcel is already delivered.',
  'Aaj hi dispatch ho jayega sir.',
  'The order was dispatched today; here is your tracking link.',
  'Shop opens at 10 am and closes at 6 pm.',
  'Call after 10 baje sir.',
  'You can visit at 4 pm sir.',
  '4 baje aa jaiye sir.',
  'I cannot promise it will arrive by 4 pm.',
  'It will not arrive by 4 pm.',
  '4 baje tak deliver karva denge aisa confirm nahi kar sakta sir.',
  'You asked for delivery by 4 pm. Ketu will check.',
  'Will it arrive by 4 pm?',
  '[DEFER]',
  'Sir, shop opens at 10 am. Your parcel will arrive soon.',
]) assert.equal(arrivalClockGuard({ buyerText, reply }), null, reply)

assert.equal(arrivalClockGuard({ buyerText: 'Red restock kab hoga?', reply: 'Red stock 4 baje aa jayega.' }), null)
assert.equal(arrivalClockGuard({ buyerText, reply: 'The catalogue is https://sale91.com/catalog. It will arrive by 4 pm.' }), 'The catalogue is https://sale91.com/catalog.\n[DEFER]')
assert.equal(arrivalClockGuard({ buyerText, reply: 'Shop opens at 10 am. Parcel 4 baje tak pahunch jayega. [DEFER]' }), 'Shop opens at 10 am.\n[DEFER]')
console.log('34 arrival-clock checks passed')
