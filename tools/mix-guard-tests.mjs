// Regression: MIX-DENIAL GUARD (2026-09-06). Pure regex tests.
import { MIX_DENIAL_RE as M } from '../server/process.js'
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(62)} got=${got} want=${want}`) }
t('MISS 03:16: har product ka alag-alag 5 pcs, mix nahi chalega', M.test('Har product ka alag-alag 5 pcs lena hoga sir, mix nahi chalega 🙏'), true)
t('MISS 03:22: 10 pcs alag-alag product mein mix nahi hota', M.test('10 pcs alag-alag product mein mix nahi hota sir, har product ka 10 pcs lena hoga bulk rate ke liye'), true)
t('english cannot mix', M.test("You cannot mix products for the bulk rate sir"), true)
t("english can't be mixed", M.test("Products can't be mixed sir, 10 of each"), true)
t('mix not allowed', M.test('Mixing is not allowed sir'), true)
t('allowed: haan mix kar sakte ho', M.test('Haan sir, mix kar sakte ho — total 10+ pcs pe sab pe bulk rate lagta hai 👉 https://sale91.com'), false)
t('allowed: mixed order fine', M.test('Mixed order chalega sir, total 10+ pcs pe bulk rate'), false)
t('allowed: colour mix note', M.test('Colours mix kar lijiye sir, koi dikkat nahi'), false)
t('allowed: unrelated nahi chalega', M.test('COD single piece pe nahi chalega sir'), false)
t('allowed: holding line', M.test('Ketu will reply shortly sir 🙏'), false)
console.log(`\n${pass}/${total} passed`); process.exit(pass === total ? 0 : 1)
