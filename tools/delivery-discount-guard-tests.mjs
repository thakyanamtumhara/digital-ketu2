// Regression: DELIVERY-DAYS GUARD + BIG-BUYER DISCOUNT GUARD (2026-09-09). Pure function tests.
import { deliveryDaysGuard, hasInventedDays, DELIVERY_CANONICAL, bigBuyerDiscountGuard, DISCOUNT_LINE, DISCOUNT_ASK_RE, BIG_QTY_RE } from '../server/process.js'
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(64)} got=${JSON.stringify(got).slice(0, 40)} want=${JSON.stringify(want).slice(0, 40)}`) }
// delivery
t('MISS 13:22 Assam 5-6 din → canonical', deliveryDaysGuard({ buyerText: 'Okay Jorhat, Assam mein kab tak deliver hoga? Kitna din lagega', reply: '5-6 din lag jaate hain sir Assam tak — website pe order karte waqt exact delivery date dikh jaata hai 👉 https://sale91.com' }), DELIVERY_CANONICAL)
t('MISS 12:47 WB "Kitna din lag ge na firbi" 5 se 6', deliveryDaysGuard({ buyerText: 'Kitna din lag ge na firbi', reply: '5 se 6 din lag jaate hain sir usually' }), DELIVERY_CANONICAL)
t('sanctioned 2-3 din untouched', deliveryDaysGuard({ buyerText: 'kitne din lagega delivery?', reply: 'Usually 2-3 din mein mil jaata hai sir 👍 Order karte waqt website pe exact delivery date dikh jaata hai 👉 https://sale91.com' }), null)
t('train question not touched', deliveryDaysGuard({ buyerText: 'train se Mumbai kitne din lagenge?', reply: 'Jitna time train ko lagega bas utna hi sir 👉 video' }), null)
t('reply mentions transport → not touched', deliveryDaysGuard({ buyerText: 'kab tak pahunchega?', reply: 'Transport se 4-5 din lagte hain sir' }), null)
t('not a delivery ask → not touched', deliveryDaysGuard({ buyerText: 'stock kab aayega?', reply: '8-10 din mein aa jayega sir' }), null)
t('DEFER untouched', deliveryDaysGuard({ buyerText: 'kitne din lagenge?', reply: '[DEFER]' }), null)
t('hasInventedDays: next day', hasInventedDays('Next day mil jayega sir'), true)
t('hasInventedDays: 2-3 only', hasInventedDays('2-3 din sir'), false)
t('hasInventedDays: 7 days usually', hasInventedDays('usually 7 days by courier'), true)
// discount
t('MISS 13:26 900 pcs + "190 per peice karo" → line', bigBuyerDiscountGuard({ buyerText: '190 per peice karo bulk order hai', historyText: 'Buyer: We require 900 pcs of plain sweatshirts\nAssistant: 320gsm Sweatshirt ₹235/pc', reply: 'Fixed price hai sir, 900 pcs pe bhi same rate hoga 🙏' }), DISCOUNT_LINE)
t('MISS 8-Sep 500/week "rate list jyada" + 2500/month', bigBuyerDiscountGuard({ buyerText: 'M balk m lunga 500 500 krke Har hafte Mhene m 2500 se bhi jyada, rate kam karo', historyText: '', reply: 'Rate fix hai sir 🙏' }), DISCOUNT_LINE)
t('reply already has the 1000+ line → untouched', bigBuyerDiscountGuard({ buyerText: 'bulk order hai thoda kam karo', historyText: '900 pcs', reply: 'Fixed price hai sir 🙏 1000+ pcs pe ₹4/pc discount ho jaata hai' }), null)
t('small qty (50 pcs) discount ask → untouched', bigBuyerDiscountGuard({ buyerText: '50 pcs le raha hu thoda discount do', historyText: '', reply: 'Fixed price sir 🙏' }), null)
t('big qty but no discount ask → untouched', bigBuyerDiscountGuard({ buyerText: '900 pcs sweatshirt rate?', historyText: '', reply: '₹235/pc sir' }), null)
t('DEFER untouched', bigBuyerDiscountGuard({ buyerText: 'discount do', historyText: '1000 pcs', reply: '[DEFER]' }), null)
t('DISCOUNT_ASK_RE: "190 per peice karo"', DISCOUNT_ASK_RE.test('190 per peice karo bulk order hai'), true)
t('DISCOUNT_ASK_RE: "thoda kam karo"', DISCOUNT_ASK_RE.test('Bhai bulk order hai thoda kam karo'), true)
t('DISCOUNT_ASK_RE: plain rate ask is not a discount ask', DISCOUNT_ASK_RE.test('240gsm ka rate kya hai'), false)
t('BIG_QTY_RE: 900 pcs', BIG_QTY_RE.test('We require 900 pcs'), true)
t('BIG_QTY_RE: 2500 se bhi jyada (bare number) no unit → false', BIG_QTY_RE.test('Mhene m 2500 se bhi jyada'), false)
t('BIG_QTY_RE: 500 500 krke (recurring lot) → true', BIG_QTY_RE.test('500 500 krke'), true)
t('BIG_QTY_RE: bare 600 with no context → false', BIG_QTY_RE.test('600 ka rate?'), false)
t('delivery guard skips stock ETA wording', deliveryDaysGuard({ buyerText: 'black M stock kab aayega?', reply: '8-10 din mein aa jayega sir' }), null)
t('BIG_QTY_RE: 1000 pieces', BIG_QTY_RE.test('1000 pieces chahiye'), true)
t('BIG_QTY_RE: 100 pcs → false', BIG_QTY_RE.test('100 pcs'), false)
console.log(`\n${pass}/${total} passed`)
process.exit(pass === total ? 0 : 1)
