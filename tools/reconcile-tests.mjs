// Regression: reconcile.js — merge, ordering, double-reply guards, sweep window. Pure, no network.
import { mergeUnseenInbound, pickSweepCandidates, markSeen, wasSeen, pruneSeen, rowToMessage, orderBurst, isExcludedRow, SEEN_TTL_MS, syntheticFromPendingDefer, partialDeferSplit } from '../server/reconcile.js'

let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(50)} ${ok ? '' : 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)}`) }

const T0 = '2026-08-31T10:33:00.000Z', T1 = '2026-08-31T10:33:10.000Z', T2 = '2026-08-31T10:33:25.000Z'
const burst = [{ messageId: 'wamid.C', messageText: 'Off white, beige ka stock nhi h website pe', timestamp: T2 }]
const inbox = [
  { id: 'm1', whatsappId: 'wamid.A', content: 'Hi', messageType: 'TEXT', createdAt: T0 },
  { id: 'm2', whatsappId: 'wamid.B', content: 'Bhai shorts ka stock refill kab kroge aap', messageType: 'TEXT', createdAt: T1 },
  { id: 'm3', whatsappId: 'wamid.C', content: 'Off white, beige ka stock nhi h website pe', messageType: 'TEXT', createdAt: T2 },
]
// the 31-Aug case: A was logged (welcome scheduled), B was LOST, C is the burst
const known = id => id === 'wamid.A'
const r = mergeUnseenInbound(burst, inbox, known)
t('lost middle message is recovered',            r.added.map(m => m.messageId), ['wamid.B'])
t('order is by timestamp (B before C)',          r.messages.map(m => m.messageId), ['wamid.B', 'wamid.C'])
t('recovered row is flagged reconciled',         r.added[0].reconciled, true)
t('recovered row carries wwbun id for media',    r.added[0].wwbunMessageId, 'm2')
t('already-known ids are never re-added',        mergeUnseenInbound([], inbox, () => true).added.length, 0)
t('empty inbox → burst unchanged',               mergeUnseenInbound(burst, [], known).messages.length, 1)
t('rows without whatsappId are ignored',         mergeUnseenInbound([], [{ id: 'x', content: 'y' }], () => false).added.length, 0)
t('media row → hasMedia + lowercase type',       (m => [m.hasMedia, m.messageType])(rowToMessage({ id: 'm', whatsappId: 'w', messageType: 'IMAGE', mediaUrl: 'u' })), [true, 'image'])

// seen-set
markSeen('wamid.Z')
t('seen right after mark',                       wasSeen('wamid.Z'), true)
t('unknown id not seen',                         wasSeen('wamid.Q'), false)
t('prune keeps fresh ids',                       pruneSeen() >= 1, true)
t('prune drops old ids',                         pruneSeen(Date.now() + 31 * 60 * 1000), 0)

// sweep window
const now = new Date('2026-09-02T05:00:00Z').getTime()
const mk = (id, secAgo, num = '919818070935') => ({ id: 'r' + id, whatsappId: 'wamid.' + id, content: 'x', messageType: 'TEXT', createdAt: new Date(now - secAgo * 1000).toISOString(), whatsappNumber: num })
const rows = [mk('fresh', 30), mk('due', 120), mk('old', 400), mk('ig', 120, 'ig:4287352018153969'), mk('known', 120)]
const picked = pickSweepCandidates(rows, id => id === 'wamid.known', { now })
t('sweep picks 90s+ old, WhatsApp, unknown (30-min window keeps the 400s one)', picked.map(p => p.message.messageId), ['wamid.due', 'wamid.old'])
t('sweep candidate carries the buyer number',    picked[0].number, '919818070935')
t('sweep window upper bound = seen-set TTL',     pickSweepCandidates([mk('late', SEEN_TTL_MS / 1000 + 5)], () => false, { now }).length, 0)

// review 2026-09-02: rows wwbun would never have forwarded
t('reminder STOP tap is excluded',               isExcludedRow({ content: 'Stop messages', whatsappNumber: '919999999999' }), true)
t('reminder STOCK tap (case-insens.) excluded',  isExcludedRow({ content: '  send me STOCK updates ' , whatsappNumber: '919999999999' }), true)
t('operator number excluded',                    isExcludedRow({ content: 'note to self', whatsappNumber: '918527150400' }), true)
t('normal buyer row not excluded',               isExcludedRow({ content: 'rate?', whatsappNumber: '919818070935' }), false)
t('sticker row excluded',                        isExcludedRow({ content: '[Sticker]', messageType: 'IMAGE', whatsappNumber: '919818070935' }), true)
t('sweep drops a STOP tap',                      pickSweepCandidates([{ ...mk('tap', 120), content: 'Stop messages' }], () => false, { now }).length, 0)
t('merge drops a STOP tap',                      mergeUnseenInbound([], [{ id: 'x', whatsappId: 'wamid.tap', content: 'Stop messages', createdAt: T1 }], () => false).added.length, 0)

// review 2026-09-02: a retried forward can land A after B — burst is always timestamp-ordered, synthetic first
const ob = orderBurst([
  { messageId: 'wamid.B', timestamp: T2 },
  { messageId: null, messageText: 'Hi (carried)', timestamp: '2026-09-01T00:00:00Z' },
  { messageId: 'wamid.A', timestamp: T1 },
])
t('orderBurst: synthetic pinned first, then by time', ob.map(m => m.messageId), [null, 'wamid.A', 'wamid.B'])

// 2026-08-31 for real: a pending defer is CARRIED into the next burst, never dropped
const pend = { messages: [{ conversationId: 'c1', mergedText: 'Hi\nBhai shorts ka stock refill kab kroge aap', messageIds: ['wamid.B'], logData: {} }], deferMessage: 'Ketu will reply shortly sir 🙏' }
const syn = syntheticFromPendingDefer(pend, 'Off white, beige ka stock nhi h website pe')
t('carried defer → synthetic with text',          syn && syn.messageText, 'Hi\nBhai shorts ka stock refill kab kroge aap')
t('carried defer keeps the held message ids',     syn && syn.carriedMessageIds, ['wamid.B'])
t('carried defer has no id of its own (pinned)',  syn && syn.messageId, null)
t('carried defer is pinned first by orderBurst',  orderBurst([{ messageId: 'wamid.C', timestamp: T2 }, syn]).map(m => m.messageId), [null, 'wamid.C'])
t('same text re-sent → ownership carried, no text', (s => [s.messageText, s.carriedDefer, s.carriedMessageIds])(syntheticFromPendingDefer({ messages: [{ mergedText: 'rate?', messageIds: ['w9'] }] }, 'rate?')), ['', true, ['w9']])
t('empty pending → null',                         syntheticFromPendingDefer({ messages: [] }, 'x'), null)

// partial defer: answer + [DEFER] → send the answer, hold the rest; bare marker → full defer
t('pure [DEFER] is a full defer',                 partialDeferSplit('[DEFER]'), { isDefer: true, isPartial: false, text: '' })
t('[DEFER] with stray words is still full',       partialDeferSplit('Sir 🙏 [DEFER]').isPartial, false)
t('answer + [DEFER] is partial, marker stripped', partialDeferSplit('Hoodie 430gsm ₹402/pc sir 👉 https://sale91.com/catalog/p/hoodie-430gsm\n[DEFER]'), { isDefer: true, isPartial: true, text: 'Hoodie 430gsm ₹402/pc sir 👉 https://sale91.com/catalog/p/hoodie-430gsm' })
t('marker mid-line also stripped cleanly',        partialDeferSplit('Price ₹402 sir [DEFER] ').text, 'Price ₹402 sir')
t('no marker → plain reply untouched',            partialDeferSplit('Ok sir 🙏'), { isDefer: false, isPartial: false, text: 'Ok sir 🙏' })
t('narration + [DEFER] is a FULL defer',          partialDeferSplit('This is an order tracking request which I cannot handle.\n[DEFER]').isPartial, false)
t('holding line + [DEFER] is a FULL defer',       partialDeferSplit('Ketu will reply shortly sir 🙏 [DEFER]').isPartial, false)
t('"I cannot check" + [DEFER] is a FULL defer',   partialDeferSplit('I cannot check order status sir [DEFER]').isPartial, false)
t('carried defer keeps the original entry',       !!(syn && syn.deferEntry && syn.deferEntry.messages.length === 1 && syn.deferEntry.deferMessage), true)
t('carried partial exposes the answered part',    syntheticFromPendingDefer({ messages: [{ mergedText: 'not received + price?', messageIds: ['w1'], answered: 'Hoodie ₹402 sir' }] }, 'x').carriedAnswered, 'Hoodie ₹402 sir')

console.log(`\n${pass}/${total} passed`)
process.exit(pass === total ? 0 : 1)
