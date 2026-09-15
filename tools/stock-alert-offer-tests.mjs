import assert from 'node:assert/strict'
import { stockAlertOfferGuard } from '../server/stock-alert-offer.js'
import { restockPointerGuard } from '../server/restock-pointer.js'

const now = Date.parse('2026-09-15T07:20:00Z')
const phone = '919999999999'
const url = 'https://www.bulkplaintshirt.com/delhi-stock.html?alert=1&ph=9999999999'
const first = { buyerMessage: '240 off white S,M kabtak milega?', aiReply: 'Off-white S aur M abhi out of stock hai sir, koi shipment nahi hai filhaal — Coming Soon tab check karte rahiye 👉 https://www.bulkplaintshirt.com/delhi-stock.html', status: 'REPLIED', createdAt: '2026-09-15T07:19:00Z' }
const repeat = 'Off-white S,M ka koi shipment nahi hai abhi sir, date nahi de sakta — Coming Soon tab check karte rahiye 🙏'
const call = (extra = {}) => stockAlertOfferGuard({ buyerText: first.buyerMessage, reply: first.aiReply, whatsappNumber: phone, now, ...extra })
const offered = call()
const priorAlert = { ...first, aiReply: offered }
const cases = [
  ['first stock timing gets a compact alert with original facts', () => { assert.ok(offered.includes(url)); assert.ok(offered.startsWith('Off-white S aur M abhi out of stock hai sir, koi shipment nahi hai filhaal')); assert.ok(!/Coming Soon/i.test(offered)) }],
  ['reported one-week follow-up gets its first alert', () => { const reply = call({ buyerText: '1 week ke andar milega?', history: [first], reply: repeat }); assert.ok(reply.includes(url)); assert.ok(!/Coming Soon|1 week/i.test(reply)); assert.equal(restockPointerGuard({ buyerText: '1 week ke andar milega?', history: [first], reply, now }), null) }],
  ['same timing after the alert hands off instead of looping', () => assert.equal(call({ buyerText: '1 week ke andar milega?', history: [priorAlert], reply: repeat }), '[DEFER]')],
  ['same alert offered again on an unknown timing hands off', () => assert.equal(call({ buyerText: 'Kab milega?', history: [priorAlert], reply: offered }), '[DEFER]')],
  ['explicit resend remains allowed', () => assert.ok(call({ buyerText: 'Alert link dobara bhej do', history: [priorAlert], reply: repeat }).includes(url))],
  ['different colour can get its first alert', () => assert.ok(call({ buyerText: '240 Red M kab milega?', history: [priorAlert], reply: 'Red M is out of stock.' }).includes(url))],
  ['different size can get its first alert', () => assert.ok(call({ buyerText: '240 Off-white XL kab milega?', history: [priorAlert], reply: 'Off-white XL is out of stock.' }).includes(url))],
  ['different product can get its first alert', () => assert.ok(call({ buyerText: 'Acid wash Black M kab aayega?', history: [priorAlert], reply: 'Black M acid wash is out of stock.' }).includes(url))],
  ['stale alert does not establish current loop', () => assert.ok(call({ history: [{ ...priorAlert, createdAt: '2026-09-14T00:00:00Z' }] }).includes(url))],
  ['missing history time cannot establish a loop', () => assert.ok(call({ history: [{ ...priorAlert, createdAt: null }] }).includes(url))],
  ['unsent alert does not suppress a useful offer', () => assert.ok(call({ history: [{ ...priorAlert, status: 'FAILED' }] }).includes(url))],
  ['stock overview remains unchanged prose', () => assert.equal(call({ buyerText: 'Live stock ki poori list ka link bhejo', reply: 'Live stock yahan dekhiye sir 👉 https://www.bulkplaintshirt.com/delhi-stock.html' }), null)],
  ['in-stock order answer stays unchanged', () => assert.equal(call({ reply: 'Off-white S,M available hai sir 👉 https://sale91.com/catalog/p/oversize-240gsm' }), null)],
  ['real exact ETA is preserved and paired with first alert', () => { const reply = call({ reply: 'Off-white S aur M are out of stock, arriving in 4 days.' }); assert.ok(reply.includes('arriving in 4 days')); assert.ok(reply.includes(url)) }],
  ['fresh ETA after previous alert remains answerable', () => assert.equal(call({ history: [priorAlert], reply: 'Off-white S,M are out of stock, arriving in 4 days.' }), null)],
  ['not-made colour cannot receive an alert', () => assert.equal(call({ buyerText: 'Kids Green kab aayega?', reply: 'Green kids mein nahi banta sir, available colours photos mein hain.' }), null)],
  ['discontinued size cannot receive an alert', () => assert.equal(call({ buyerText: '240 Red XS kab aayega?', reply: "240gsm Red XS won't be restocked sir; XS is now made only in Black/White." }), null)],
  ['no production plan cannot receive an alert', () => assert.equal(call({ reply: 'No plan to make Off-white S,M. Coming Soon check karte rahiye.' }), null)],
  ['order tracking cannot inherit stock context', () => assert.equal(call({ buyerText: 'Mera order 1 week ke andar milega?', history: [first], reply: 'Check tracking sir https://sale91.com/?S=1234' }), null)],
  ['acknowledgement cannot trigger a stock offer', () => assert.equal(call({ buyerText: 'Ok sir', history: [first] }), null)],
  ['pure owner handoff is preserved', () => assert.equal(call({ reply: '[DEFER]' }), null)],
  ['pure silence is preserved', () => assert.equal(call({ reply: '[SKIP]' }), null)],
  ['mixed answer and partial handoff are retained', () => { const reply = call({ reply: 'Off-white S,M are out of stock. Hoodie photos: https://example.com/photos\n[DEFER]' }); assert.ok(reply.includes('Hoodie photos: https://example.com/photos')); assert.ok(reply.includes(url)); assert.ok(reply.endsWith('[DEFER]')) }],
  ['fresh in-stock alternative is never discarded by loop handling', () => assert.equal(call({ history: [priorAlert], reply: 'Off-white S,M are out of stock. Black M is available now.' }), null)],
  ['question to resolve the product is not an alert target', () => assert.equal(call({ buyerText: 'Polo kab milega?', reply: 'Which polo sir, cotton or premium?' }), null)],
  ['ambiguous named product cannot be inferred from its answer', () => assert.equal(call({ buyerText: 'Polo kab milega?', reply: 'Cotton Polo out of stock sir.' }), null)],
  ['English buyer gets an English offer', () => { const reply = call({ english: true, reply: 'Off-white S,M are out of stock. Please keep checking the Coming Soon section.' }); assert.ok(reply.includes('Set an alert here sir')); assert.ok(!/Coming Soon|lijiye|jayega/i.test(reply)) }],
  ['unknown phone leaves form entry to buyer', () => { const reply = call({ whatsappNumber: '891083237' }); assert.ok(reply.includes('?alert=1')); assert.ok(!reply.includes('&ph=')) }],
  ['Instagram identifier is never used as phone', () => assert.ok(!call({ whatsappNumber: 'ig:919999999999' }).includes('&ph='))],
  ['existing first natural alert remains untouched', () => assert.equal(call({ reply: offered }), null)],
  ['plain old stock-page link is not an earlier alert', () => assert.ok(call({ buyerText: '1 week ke andar milega?', history: [first], reply: repeat }).includes(url))],
  ['upgraded link with only stock prose still gets a human offer', () => { const reply = call({ reply: first.aiReply.replace('https://www.bulkplaintshirt.com/delhi-stock.html', url) }); assert.ok(reply.includes('Alert laga lijiye')); assert.ok(!/Coming Soon/.test(reply)); assert.equal(reply.split(url).length - 1, 1) }],
  ['upgraded stock-overview link is not an earlier spoken alert offer', () => assert.ok(call({ buyerText: '1 week ke andar milega?', history: [{ ...first, aiReply: 'Live stock yahan dekhiye ' + url }], reply: repeat }).includes(url))],
  ['unspecified unavailable may be a permanent catalogue fact', () => assert.equal(call({ buyerText: 'Kids Green kab aayega?', reply: 'Green kids mein available nahi hai sir.' }), null)],
  ['unknown no-date answer adds no invented out-of-stock assertion', () => { const reply = call({ reply: 'Off-white S,M ka date nahi pata sir.' }); assert.ok(reply.includes(url)); assert.ok(!/out of stock/i.test(reply)) }],
  ['ordinary fact punctuation is retained', () => { const reply = call({ reply: 'Off-white S,M are out of stock; Black L is available now. Photos: https://example.com/gallery\n[DEFER]' }); assert.ok(reply.startsWith('Off-white S,M are out of stock; Black L is available now. Photos: https://example.com/gallery')); assert.ok(reply.endsWith('[DEFER]')) }],
  ['out-of-stock availability answer can suggest the alert', () => assert.ok(call({ buyerText: '240 Off-white S available hai kya?' }).includes(url))],
  ['missing page information can receive the first useful alert', () => assert.ok(call({ buyerText: 'Usme information nahi hai', history: [first], reply: repeat }).includes(url))],
  ['missing page information after the alert does not loop it', () => assert.equal(call({ buyerText: 'Usme information nahi hai', history: [priorAlert], reply: repeat }), '[DEFER]')],
  ['prior omitted product can resolve from its explicit answer', () => assert.equal(call({ buyerText: 'Isme toh acid wash nahi hai', history: [{ ...priorAlert, buyerMessage: 'Restock kab hoga?', aiReply: 'Acid wash Black M ka koi shipment nahi hai, alert laga lijiye ' + url }], reply: 'Acid wash uss page pe abhi list nahi hai sir, Black M ka koi shipment nahi hai, jo available hai wo le lijiye.' }), '[DEFER]')],
  ['procurement follow-up after an alert hands off its unknown timing', () => assert.equal(call({ buyerText: 'Abhi mangwa sakte hai kya?', history: [{ ...priorAlert, buyerMessage: 'Isme acid wash nahi hai', aiReply: 'Acid wash Black M ka koi shipment nahi hai, alert laga lijiye ' + url }], reply: 'Abhi nahi bata sakta sir, acid wash Black M ka koi shipment nahi hai.' }), '[DEFER]')],
  ['specific available alternative survives generic-alternative cleanup', () => assert.equal(call({ buyerText: 'Abhi mangwa sakte hai kya?', history: [{ ...priorAlert, buyerMessage: 'Isme acid wash nahi hai', aiReply: 'Acid wash Black M ka koi shipment nahi hai, alert laga lijiye ' + url }], reply: 'Acid wash Black M ka koi shipment nahi hai, Black XL available hai.' }), null)],
  ['spoken offer without its link receives only the missing link', () => assert.equal(call({ reply: 'Alert laga lijiye sir' }), 'Alert laga lijiye sir 👉 ' + url)],
  ['prior spoken offer without a link cannot suppress the first usable offer', () => assert.ok(call({ buyerText: '1 week ke andar milega?', history: [{ ...priorAlert, aiReply: 'Alert laga lijiye sir' }], reply: repeat }).includes(url))],
  ['external query containing an owned URL is not a usable alert link', () => assert.ok(call({ reply: 'Alert laga lijiye sir example.com/?url=https://www.bulkplaintshirt.com/delhi-stock.html?alert=1' }).endsWith('👉 ' + url))],
  ['Markdown alert link remains a usable first offer', () => assert.equal(call({ reply: 'Set a stock alert [here](' + url + ')' }), null)],
  ['repeated timing cannot discard a cotton composition answer', () => assert.equal(call({ buyerText: '240 Off-white S restock, cotton hai?', history: [priorAlert], reply: 'Off-white S is out of stock. It is 100% cotton.' }), null)],
  ['repeated timing cannot discard an unlisted fabric property', () => assert.equal(call({ history: [priorAlert], reply: 'Off-white S,M are out of stock; preshrunk hai sir.' }), null)],
  ['repeated timing cannot discard an unlisted packaging answer', () => assert.equal(call({ history: [priorAlert], reply: 'Off-white S,M are out of stock; plain packaging sir.' }), null)],
  ['bare cotton property survives even without a percentage', () => assert.equal(call({ history: [priorAlert], reply: 'Off-white S,M are out of stock, cotton hai sir.' }), null)],
  ['English alert echo still hands off unknown timing', () => assert.equal(call({ history: [priorAlert], reply: 'Off-white S,M are out of stock. Set an alert here sir; you will get a WhatsApp when it is back 👉 ' + url }), '[DEFER]')],
  ['existing stock link and independent photo link are retained once', () => { const reply = call({ reply: 'Off-white S,M are out of stock; photos https://example.com/photos. Stock yahan ' + url }); assert.equal(reply.split(url).length - 1, 1); assert.ok(reply.includes('photos https://example.com/photos')); assert.ok(reply.endsWith('stock aane par WhatsApp aa jayega')) }],
  ['previous browser notification offer cannot suppress the WhatsApp form', () => assert.ok(call({ buyerText: '1 week ke andar milega?', history: [{ ...priorAlert, aiReply: 'Alert laga lijiye sir https://sale91.com/?stockalert=1' }], reply: repeat }).includes(url))],
  ['previous plain sheet alert wording cannot suppress the WhatsApp form', () => assert.ok(call({ buyerText: '1 week ke andar milega?', history: [{ ...priorAlert, aiReply: 'Alert laga lijiye sir https://www.bulkplaintshirt.com/delhi-stock.html' }], reply: repeat }).includes(url))],
]
for (const [name, test] of cases) { test(); console.log('PASS ' + name) }
console.log(cases.length + ' stock-alert offer checks passed')
