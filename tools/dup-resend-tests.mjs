// Regression: DUPLICATE RE-SEND + shared holding-line repeat check (2026-09-05). Pure.
import { isDuplicateResend, normalizeForDup, holdingLineRepeatFromRows } from '../server/process.js'
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(60)} got=${got} want=${want}`) }
const A = 'Hi Shibin.\nGood evening. 😊\nThis is the EU size chart. Please let me know if you could get me T-shirts of this size.'
const B = 'Good evening. 😊\nThis is the EU size chart. Please let me know if you could get me T-shirts of this size.'
t('MISS 2026-09-05: re-send minus greeting = duplicate', isDuplicateResend(B, [A]), true)
t('same text exactly = duplicate', isDuplicateResend(A, [A]), true)
t('reverse containment (longer re-send) = duplicate', isDuplicateResend(A, [B]), true)
t('short nudge never a duplicate', isDuplicateResend('hello?', ['hello?']), false)
t('different question, same opening = not duplicate', isDuplicateResend('Good evening. What is the price of the 240gsm oversize black tee for 50 pieces?', [B]), false)
t('follow-up quoting a fragment = not duplicate', isDuplicateResend('This is the EU size chart', [A]), false)
t('nothing answered = not duplicate', isDuplicateResend(A, []), false)
t('hindi text normalises', normalizeForDup('क्या आप 240 gsm में ब्लैक देते हो?').length > 10, true)
// holding-line repeat from rows (newest first)
t('hold 13 min ago, only a greeting since → repeat', holdingLineRepeatFromRows([{ status: 'REPLIED', deferReason: 'welcome_followup_generic' }, { status: 'DEFERRED', deferReason: 'claude_deferred', sentViaWwbun: true }]), true)
t('Ketu replied since → not a repeat', holdingLineRepeatFromRows([{ status: 'SKIPPED', deferReason: 'manual_reply' }, { status: 'DEFERRED', deferReason: 'claude_deferred', sentViaWwbun: true }]), false)
t('real AI answer since → not a repeat', holdingLineRepeatFromRows([{ status: 'REPLIED', deferReason: null }, { status: 'DEFERRED', deferReason: 'claude_deferred', sentViaWwbun: true }]), false)
t('partial answer does not clear the held part', holdingLineRepeatFromRows([{ status: 'REPLIED', deferReason: 'claude_partial_answer' }, { status: 'DEFERRED', deferReason: 'claude_deferred', sentViaWwbun: true }]), true)
t('hold not delivered → no repeat', holdingLineRepeatFromRows([{ status: 'DEFERRED', deferReason: 'claude_deferred', sentViaWwbun: false }]), false)
t('no rows → no repeat', holdingLineRepeatFromRows([]), false)
console.log(`\n${pass}/${total} passed`); process.exit(pass === total ? 0 : 1)
