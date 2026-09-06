import { isStockAvailabilityQuestion as q, isTransactionalReply as tr } from '../server/stock-question.js'
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(60)} got=${got} want=${want}`) }
t('MISS 20:12: women launch estimated time', q('Reel dekhi ki women launch finally launch horaha hai Estimated time kya hai'), true)
t('womens kab launch hogi', q('womens line kab launch hogi?'), true)
t('when will you launch ladies', q('When will you launch the ladies range'), true)
t('kitne din mein aayegi (restock phrasing) still true', q('navy hoodie kab aayega'), true)
t('plain price ask stays false', q('240 gsm ka rate kya hai'), false)
t('"launch" as a brand word without timing → false', q('I am launching my brand, need 100 tees'), false)
t('eta word', q('ETA for the zipper hoodie?'), true)
t('default: "30 to 45 days max" is transactional (delivery-timing clause)', tr('30 to 45 days max'), true)
t('forTiming: "30 to 45 days max" is NOT transactional', tr('30 to 45 days max', { forTiming: true }), false)
t('forTiming: "October mein aayega" is NOT transactional', tr('October mein aayega', { forTiming: true }), false)
t('forTiming: a tracking link is still transactional', tr('https://shiprocket.co/tracking/7D117185230', { forTiming: true }), true)
t('forTiming: credentials still transactional', tr('Email: x@gmail.com Password: 12345678', { forTiming: true }), true)
t('default: "7 din mein aa jayega" transactional', tr('7 din mein aa jayega'), true)
console.log(`\n${pass}/${total} passed`); process.exit(pass === total ? 0 : 1)
