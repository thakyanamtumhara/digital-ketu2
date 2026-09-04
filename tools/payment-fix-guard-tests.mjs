// Regression: PAYMENT-FIX FABRICATION GUARD (2026-09-04) — buyer-side trouble detector + reply-side
// invented-retry detector. Pure regex tests; the guard converts such a reply to [DEFER].
import { PAYMENT_TROUBLE_RE as T, INVENTED_RETRY_RE as R } from '../server/process.js'

let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(48)} got=${got} want=${want}`) }

// buyer side — trouble
t('MISS 2026-09-03: "payment now kar rha to ye aa rha hai ??"', T.test('Bhaiya payment now kar rha to ye aa rha hai ??'), true)
t('payment failed',                              T.test('payment failed 3 times sir'), true)
t('UPI nahi ho raha',                            T.test('upi se payment nahi ho raha'), true)
t('card declined',                               T.test('my card is getting declined at checkout'), true)
t('error aa raha hai payment karte time',        T.test('error aa raha hai jab payment kar raha hu'), true)
// buyer side — not trouble
t('how to pay (method ask)',                     T.test('kaise pay karu? UPI chalega?'), false)
t('paid, dispatch it',                           T.test('payment done, dispatch kar dena'), false)
t('OTP not coming (separate rule)',              T.test('OTP nahi aa raha email pe'), false)
// reply side — invented retry
t('MISS reply: 10 minute wait karke dobara',      R.test('Screenshot mila sir 🙏 10 minute wait karke dobara order daal dijiye'), true)
t('15-20 min baad try',                          R.test('15-20 min baad try kar lijiye sir'), true)
t('thodi der baad phir se try',                  R.test('Thodi der baad phir se try kariye sir 🙏'), true)
t('retry',                                       R.test('Please retry the payment sir'), true)
// reply side — allowed
t('holding line',                                R.test('Ketu will reply shortly sir 🙏'), false)
t('OTP email check line',                        R.test('Email sahi likha hai check kar lijiye sir, OTP wahin aata hai (spam folder bhi dekh lo)'), false)
t('desktop mode QR fix (sanctioned)',            R.test('Desktop mode mein khol lijiye sir, QR code aa jayega'), false)
t('payment method answer',                       R.test('Website pe UPI, card ya net banking se pay kar sakte ho sir 👉 https://sale91.com'), false)

console.log(`\n${pass}/${total} passed`)
process.exit(pass === total ? 0 : 1)
