import { LOGISTICS_FOLLOWUP_RE as L } from '../server/process.js'
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(60)} got=${got} want=${want}`) }
t('MISS 21:02: wahan se pick kaise karunga', L.test('Or me waha se pick kese krunha'), true)
t('12-13 km hy something', L.test('12-13 km hy something'), true)
t('porter payment follow-up', L.test('Hnn sir but uska v pay Krna hoga hum customer se ni le skte'), true)
t('kal tak aa jaye', L.test('please kl tk ajaye tho badhiya hy'), false)
t('kal tak (spaced)', L.test('kal tak aa jayega?'), true)
t('plain price question → not logistics', L.test('240 gsm ka rate kya hai'), false)
t('colour question → not logistics', L.test('black mein XL hai?'), false)
t('refund word', L.test('refund kab milega'), true)
console.log(`\n${pass}/${total} passed`); process.exit(pass === total ? 0 : 1)
