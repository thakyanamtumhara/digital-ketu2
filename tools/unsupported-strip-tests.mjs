import { stripUnsupportedPlaceholder as st } from '../server/process.js'
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(60)} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`) }
const PH = '[Unsupported] WhatsApp could not deliver this message (often a "view once" photo, poll, or forwarded post). Ask the buyer to resend it normally.'
t('MISS 14:58: greeting + prefill + placeholder → text only', st(`Hello Share Details ${PH}`), 'Hello Share Details')
t('placeholder first', st(`${PH} Hi`), 'Hi')
t('no placeholder → unchanged', st('kids tshirt hai kya?'), 'kids tshirt hai kya?')
t('placeholder only → empty', st(PH), '')
t('bare [Unsupported] token removed', st('[Unsupported] could not deliver this message x'), 'could not deliver this message x')
console.log(`\n${pass}/${total} passed`); process.exit(pass === total ? 0 : 1)
