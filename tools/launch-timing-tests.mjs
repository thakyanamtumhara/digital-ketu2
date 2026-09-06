import { isStockAvailabilityQuestion as q } from '../server/stock-question.js'
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(60)} got=${got} want=${want}`) }
t('MISS 20:12: women launch estimated time', q('Reel dekhi ki women launch finally launch horaha hai Estimated time kya hai'), true)
t('womens kab launch hogi', q('womens line kab launch hogi?'), true)
t('when will you launch ladies', q('When will you launch the ladies range'), true)
t('kitne din mein aayegi (restock phrasing) still true', q('navy hoodie kab aayega'), true)
t('plain price ask stays false', q('240 gsm ka rate kya hai'), false)
t('"launch" as a brand word without timing → false', q('I am launching my brand, need 100 tees'), false)
t('eta word', q('ETA for the zipper hoodie?'), true)
console.log(`\n${pass}/${total} passed`); process.exit(pass === total ? 0 : 1)
