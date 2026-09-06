// Regression: bill-beside-text classifier (2026-09-06). billTextConfirmsOrder is module-private, so
// this exercises it through a tiny re-export shim: copy the function's behaviour contract here.
import { readFileSync } from 'fs'
const src = readFileSync(new URL('../server/process.js', import.meta.url), 'utf8')
const m = src.match(/function billTextConfirmsOrder\(text\) \{[\s\S]*?\n\}/)
if (!m) { console.log('❌ could not locate billTextConfirmsOrder'); process.exit(1) }
const billTextConfirmsOrder = new Function(m[0] + '\nreturn billTextConfirmsOrder')()
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(64)} got=${got} want=${want}`) }
t('MISS 11:00: white order kiya, black bhej diya → NOT a confirmation', billTextConfirmsOrder('True bio neck ki maine 6 piece white order kiya tha… Aap mujhe black bhej diyaa Baki sab thik hai… [Image] Ye order tha mera'), false)
t('white ki jagah beige aaya → not', billTextConfirmsOrder('order kiya tha white, white ki jagah beige aaya'), false)
t('2 pcs missing → not', billTextConfirmsOrder('maine order kiya tha 10 pcs, 2 missing hain'), false)
t('kam aaya → not', billTextConfirmsOrder('order kiya tha 20 ka, 18 hi aaya kam aaya'), false)
t('exchange request → not', billTextConfirmsOrder('order kiya tha, size exchange karna hai'), false)
t('plain placed order → yes', billTextConfirmsOrder('Order kar diya sir, dispatch kar dena'), true)
t('paid → yes', billTextConfirmsOrder('payment done, please dispatch'), true)
t('just ordered → yes', billTextConfirmsOrder('I have just ordered 12 pcs'), true)
t('no confirmation received → not', billTextConfirmsOrder('Sample order kiya, koi confirmation nai aya'), false)
console.log(`\n${pass}/${total} passed`); process.exit(pass === total ? 0 : 1)
