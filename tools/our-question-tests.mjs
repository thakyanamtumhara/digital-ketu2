// Regression: OUR-QUESTION DETECTOR (2026-09-09) — the restraint gate must never silence an answer to the clone's own question.
import { isOurQuestion } from '../server/process.js'
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(64)} got=${got} want=${want}`) }
t('MISS 18:50 "Which product sir? Sample rates…"', isOurQuestion('Which product sir? Sample rates are listed in the catalog 👉 https://sale91.com/catalog'), true)
t('"Kaun sa product sir — Bio ya True Bio? 👉 link"', isOurQuestion('Kaun sa product sir — Bio ya True Bio? 👉 https://sale91.com/catalog'), true)
t('"Kaunsa product chahiye sir?"', isOurQuestion('Kaunsa product chahiye sir?'), true)
t('"Please tell me sir, what is your question?"', isOurQuestion("Please tell me sir, what's your question?"), true)
t('"Tell me sir, what would you like to know about 240gsm? 🙏"', isOurQuestion('Tell me sir, what would you like to know about 240gsm? 🙏'), true)
t('"Screenshot bhej dijiye sir, kya problem aa raha hai 🙏"', isOurQuestion('Screenshot bhej dijiye sir, kya problem aa raha hai 🙏'), true)
t('holding line is not a question', isOurQuestion('Ketu will reply shortly sir 🙏'), false)
t('welcome follow-up "Ask me if any questions sir?" not a question', isOurQuestion('Ask me if any questions sir?'), false)
t('plain answer with link', isOurQuestion('₹150/pc for 100 pcs sir — True Biowash Round Neck 👉 https://sale91.com'), false)
t('[DEFER]', isOurQuestion('[DEFER]'), false)
t('statement ending with emoji', isOurQuestion('Ok sir, dispatching ASAP 🚚'), false)
t('empty', isOurQuestion(''), false)
console.log(`\n${pass}/${total} passed`)
process.exit(pass === total ? 0 : 1)
