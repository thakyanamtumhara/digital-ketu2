// Regression: the mispaired-correction guard (replyAnswersBuyer) — fail-open + verdict parsing.
// Uses a FAKE anthropic client; the real Haiku call is one yes/no (~₹0.05) and is not exercised here.
import { replyAnswersBuyer, hasGarbledTranscript, isDeferLine } from '../server/stock-question.js'

const fake = (answer, fail = false) => ({ messages: { create: async () => { if (fail) throw new Error('boom'); return { content: [{ type: 'text', text: answer }] } } } })
let pass = 0, total = 0
const t = async (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(44)} got=${got} want=${want}`) }

await t('YES → store',                 await replyAnswersBuyer(fake('YES'), 'oversize 240 ka rate?', 'Bulk ₹195 sir 👉 link'), true)
await t('NO → skip',                   await replyAnswersBuyer(fake('NO'), 'yes send qr', 'XXL add kar raha hoon'), false)
await t('"No." punctuation → skip',    await replyAnswersBuyer(fake('No.'), 'ok', 'kal aayega'), false)
await t('"NOTED"-like word ≠ NO',      await replyAnswersBuyer(fake('YES — same topic'), 'a', 'b'), true)
await t('API error → fail OPEN',       await replyAnswersBuyer(fake('', true), 'rate?', '₹195 sir'), true)
await t('empty buyer → false',         await replyAnswersBuyer(fake('YES'), '', 'reply'), false)
await t('empty reply → false',         await replyAnswersBuyer(fake('YES'), 'buyer', '  '), false)
// the two deterministic siblings the write paths also apply
await t('garbled transcript detected', hasGarbledTranscript('बाहर देवली मσειल के लिए'), true)
await t('clean Hinglish not garbled',  hasGarbledTranscript('Ji sir, kal 10 baje 🙏 aa jaiye'), false)
await t('holding line is a defer',     isDeferLine('Ketu will reply shortly sir 🙏'), true)

console.log(`\n${pass}/${total} passed`)
process.exit(pass === total ? 0 : 1)
