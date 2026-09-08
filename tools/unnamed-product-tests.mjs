// Regression: PRODUCT-NOT-NAMED RESOLVER + EXPORT ASK DETECTOR (2026-09-05). Pure, no network.
import { detectColoursAndSizes, resolveUnnamedProduct, unnamedProductCandidates, unnamedProductGuard, productFamily } from '../server/stock-lookup.js'
import { EXPORT_ASK_RE } from '../server/process.js'

let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(58)} got=${JSON.stringify(got)}${ok ? '' : ' want=' + JSON.stringify(want)}`) }

// --- detector ---
let d = detectColoursAndSizes('White and nevy 38 kab tak restock hoga?')
t('MISS 2026-09-04: colours', d.colours, ['Navy', 'White'])
t('MISS 2026-09-04: sizes', d.sizes, ['38'])
t('MISS 2026-09-04: no product named', d.productNamed, false)
t('product named → true bio', detectColoursAndSizes('True Bio navy 38 kab aayega').productNamed, true)
t('product named → polo', detectColoursAndSizes('navy polo 38 hai?').productNamed, true)
t('product named → 240gsm', detectColoursAndSizes('black 240gsm M hai kya').productNamed, true)
t('bare "s" alone is not a size', detectColoursAndSizes('kya ye s kal aayega').sizes, [])
t('alpha sizes with colour', detectColoursAndSizes('black M aur L kab aayega').sizes, ['M', 'L'])
t('2xl → XXL', detectColoursAndSizes('maroon 2xl hai').sizes, ['XXL'])
t('charcol spelling', detectColoursAndSizes('charcol 40 available?').colours, ['Charcoal'])
t('neavy spelling', detectColoursAndSizes('cotton polo neavy 42 44 update').colours, ['Navy'])
t('navey spelling', detectColoursAndSizes('navey 38').colours, ['Navy'])
t('no colour → nothing', detectColoursAndSizes('38 kab aayega').colours, [])
t('off white is one colour', detectColoursAndSizes('240GSM, 220GSM me off white kabtk aa jayegi stock me').colours, ['Off-white'])
t('white and off-white both named → both', detectColoursAndSizes('white aur off white dono 38').colours, ['White', 'Off-white'])

// --- resolver on a synthetic snapshot shaped like the live one ---
const snap = {
  inStock: {
    'True Bio Rneck': { Navy: { 36: 1, 38: 1, 40: 1 }, White: { 36: 1, 38: 1 } },
    'Bio Rneck': { Navy: { 36: 1, 38: 1, 40: 1 }, White: { 36: 1, 38: 1 } },
    'Premium Polo': { Navy: { 36: 1, 38: 1, 40: 1 } },
    'Oversize 240gsm': { Navy: { S: 1, M: 1 }, Black: { S: 1, M: 1 } },
    'Kids Rneck': { White: { 20: 1, 22: 1 } },
  },
  oos: { 'True Bio Rneck': { Navy: '38,44', White: '38' }, 'Premium Polo': { Navy: '38,40' } },
  coming: { 'Premium Polo|Navy': { eta: 6, sizes: ['40', '42'] } },
  fetchedAt: 0,
}
const r = resolveUnnamedProduct(snap, 'White and nevy 38 kab tak restock hoga?')
t('resolver fires', !!r, true)
t('Navy 38 → Bio in stock', /Navy 38:.*Bio Rneck ✅ IN STOCK/.test(r), true)
t('Navy 38 → True Bio out no shipment', /Navy 38:.*True Bio Rneck ⛔ OUT, NO shipment/.test(r), true)
t('Navy 38 → Premium Polo out, shipment not 38', /Navy 38:.*Premium Polo ⛔ OUT — shipment ~6 din but NOT size 38/.test(r), true)
t('Navy 38 → alpha-size product excluded', /Oversize 240gsm/.test(r), false)
t('White 38 → Kids excluded (no 38)', /White 38:.*Kids/.test(r), false)
t('White 38 → True Bio out', /White 38:.*True Bio Rneck ⛔ OUT, NO shipment/.test(r), true)
t('instruction present', /ask which product in ONE short line/.test(r), true)
t('product named → resolver silent', resolveUnnamedProduct(snap, 'True Bio navy 38 kab aayega'), null)
t('no colour → resolver silent', resolveUnnamedProduct(snap, '38 kab aayega'), null)
t('colour only (no size) → lists sizes', /Navy: .*Bio Rneck ✅ IN STOCK \(sizes 36,38,40\)/.test(resolveUnnamedProduct(snap, 'navy kab aayega') || ''), true)
t('unknown colour for every product → silent', resolveUnnamedProduct(snap, 'orange 38 hai?'), null)

// --- export ask detector ---
const E = (s) => EXPORT_ASK_RE.test(s)
t('MISS 2026-09-05: Canada printing business + DDP', E('I need 50 blank tees for my printing business in Canada. Please quote including DDP shipping to Brampton, Ontario, Canada.'), true)
t('out of india delivery (08-28 case)', E('kya aap out of india delivery krte ho?'), true)
t('export karte ho', E('export karte ho kya sir'), true)
t('ship to Dubai', E('can you ship to Dubai?'), true)
t('Nepal me delivery', E('Nepal me delivery hoti hai?'), true)
t('international shipping', E('do you do international shipping'), true)
t('videsh', E('videsh bhejte ho?'), true)
t('domestic 50-pc English quote → no', E('Please quote your best price for 50 pcs of 240gsm oversized tees, delivery to Mumbai.'), false)
t('china ka fabric → no', E('ye china ka fabric hai kya?'), false)
t('american fit → no', E('american fit hai kya?'), false)
t('plain price ask → no', E('rate kya hai 240 gsm ka'), false)
t('"from" + city in India → no', E('main delhi se hoon, delivery kitne din me?'), false)

// --- many-candidate guard ---
const snap2 = { inStock: { 'Oversize 240gsm': { Black: { S:1, M:1, L:1, XL:1 } }, 'Oversize 210gsm': { Black: { S:1, XL:1 } }, 'Hoodie 320gsm-1': { Black: { XL:1 } }, Sweatshirt: { Black: { XL:1 } }, Shorts: { Black: { XS:1, S:1, M:1, L:1, XL:1 } } }, oos: { Shorts: { Black: 'XL' } }, coming: {}, fetchedAt: 0 }
const cands = unnamedProductCandidates(snap2, 'XL black 4 piece available')
t('MISS 2026-09-07: five candidates for XL black', cands.length, 5)
t('family mapping', productFamily('Hoodie 320gsm-1') + '/' + productFamily('AcidWash OS'), 'hoodie/acid wash')
t('guard replaces a single-product verdict', /Kaunsa product sir/.test(unnamedProductGuard({ candidates: cands, reply: 'Sir Black shorts XL abhi out of stock hai 🙏 XS, S, M, L available hain', historyText: '' }) || ''), true)
t('guard lists the families', /oversize tshirt, hoodie, sweatshirt, shorts/.test(unnamedProductGuard({ candidates: cands, reply: 'Black shorts XL out of stock hai', historyText: '' }) || ''), true)
t('guard leaves a question alone', unnamedProductGuard({ candidates: cands, reply: 'Kaunsa product chahiye sir — hoodie ya oversize?', historyText: '' }), null)
t('thread names shorts → verdict allowed', unnamedProductGuard({ candidates: cands, reply: 'Black shorts XL out of stock hai sir', historyText: 'Buyer: shorts ka rate? Assistant: Shorts ₹217' }), null)
t('two candidates → no guard', unnamedProductGuard({ candidates: cands.slice(0, 2), reply: 'Oversize 240 black XL available hai', historyText: '' }), null)
t('reply naming two families → not a single pick', unnamedProductGuard({ candidates: cands, reply: 'Hoodie aur sweatshirt dono mein Black XL available hai sir', historyText: '' }), null)
t('non-stock reply → no guard', unnamedProductGuard({ candidates: cands, reply: 'Photo bhej dijiye sir', historyText: '' }), null)
console.log(`\n${pass}/${total} passed`)
process.exit(pass === total ? 0 : 1)
