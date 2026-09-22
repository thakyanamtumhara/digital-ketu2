import assert from 'node:assert/strict'
import { stockMaintenanceGuard } from '../server/stock-maintenance.js'

const buyerText = 'Demand badh gayi hai, regular tees ka stock available rakhna please'
const reply = 'Ok sir, regular tees ka stock rakhenge 👍'
for (const promise of [reply, 'Stock available rakhenge sir', 'Stock rakhunga sir', 'Stock rakh denge sir', 'Ok sir, regular tees ka stock rakhenge, sab sizes available hain abhi 👉 https://sale91.com/catalog/p/example', 'Stock rakhenge, aap order kar lijiye 👉 https://sale91.com/catalog/p/example', 'Stock rakhenge, 3 din mein aayega', 'Stock rakhenge. Rate 200 hai.', 'Stock abhi available hai sir', 'Stock rakhne ki koshish karenge sir']) {
  assert.equal(stockMaintenanceGuard({ buyerText, reply: promise }), 'Noted sir 🙏')
}
for (const question of [
  'Stock available hai?', 'Stock kab aayega?', 'Stock available rakhna please, rate bhi batao',
  'Stock rakhna please aur dispatch karna', 'Mere liye stock rakhna please',
  'Reserve stock rakhna please', '[Image] stock rakhna please',
  'Price kya hai? Stock rakhna please', 'Refund bhi chahiye, stock rakhna please',
  'Invoice bhejna aur stock rakhna please', 'Photo share kar do, stock rakhna please',
]) assert.equal(stockMaintenanceGuard({ buyerText: question, reply }), null)
for (const answer of [
  '[DEFER]', 'Noted sir 🙏', 'Stock nahi rakhenge', 'Stock rakhenge agar production hua',
  'Stock rakhenge. Kal dispatch hoga.',
]) assert.equal(stockMaintenanceGuard({ buyerText, reply: answer }), null)
assert.equal(stockMaintenanceGuard({ buyerText, reply, imageUrl: 'https://media.invalid/photo.jpg' }), null)
console.log('27 stock-maintenance checks passed')
