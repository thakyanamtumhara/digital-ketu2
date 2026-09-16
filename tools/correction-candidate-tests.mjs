import assert from 'node:assert/strict'
import { assessReplyPair } from '../server/stock-question.js'
import { ensureLearningCandidates, validateLearningCandidate, markLearningPromoted, learningEligibility, legacyCorrectionBackfillResponse } from '../server/learning-candidates.js'

const fakeModel = (text, fail = false, stopReason = 'end_turn') => ({ messages: { create: async () => {
  if (fail) throw new Error('simulated provider outage')
  return { content: [{ type: 'text', text }], stop_reason: stopReason }
} } })
const fakeDb = () => {
  const rows = new Map(), events = []
  return {
    rows, events,
    $executeRawUnsafe: async () => { events.push('schema'); return 0 },
    $executeRaw: async (sql, ...values) => {
      const query = sql.join('?')
      if (query.includes('INSERT INTO')) {
        const [id, origin, payload] = values
        events.push('preserved')
        if (!rows.has(id)) rows.set(id, { id, origin, payload: JSON.parse(payload), status: 'pending' })
      } else if (query.includes("status = 'promoted'")) {
        rows.get(values[0]).status = 'promoted'
      } else if (query.includes('UPDATE')) {
        const [status, reason, id] = values
        Object.assign(rows.get(id), { status, reason })
      }
      return 1
    },
    $queryRaw: async (_sql, id) => rows.has(id) ? [rows.get(id)] : [],
  }
}
const input = { origin: 'edit', buyerQuestion: 'Can I mix colours?', correctReply: 'Yes sir, mix colours freely', aiWrongReply: 'Only one colour', evidence: { sourceLogId: 'synthetic-log-1' } }
let tests = 0
const test = async (name, fn) => { await fn(); tests++; console.log(`PASS ${name}`) }

await test('stock-arrival state stays evidence without validator or promotion', async () => {
  let calls = 0
  const db = fakeDb()
  const model = { messages: { create: async () => { calls++; return { content: [{ text: 'YES' }] } } } }
  const result = await validateLearningCandidate(db, model, { ...input, buyerQuestion: 'Bhai cream aaya?', correctReply: 'अभी नहीं है' })
  assert.equal(result.verdict, 'rejected')
  assert.equal(result.reason, 'perishable_stock_answer')
  assert.equal(calls, 0)
  assert.equal(db.rows.get(result.id).payload.correctReply, 'अभी नहीं है')
})

await test('Hindi tracking actions stay evidence in every learning origin', async () => {
  let calls = 0
  const model = { messages: { create: async () => { calls++; return { content: [{ text: 'YES' }] } } } }
  for (const origin of ['edit', 'intervention', 'backlog', 'reviewer_manual']) {
    for (const correctReply of ['नंबर ठीक कर दिया, ट्रैकिंग अभी भेजता हूँ।', 'ट्रेकिंग भेज दूँगा।', 'आपकी ट्रैकिंग, थोड़ी देर में भेज दूँगा।']) {
      const db = fakeDb()
      const result = await validateLearningCandidate(db, model, { ...input, origin, buyerQuestion: 'Please check my parcel details.', correctReply })
      assert.equal(result.verdict, 'rejected')
      assert.equal(result.reason, 'transactional_reply')
      assert.equal(db.rows.get(result.id).payload.correctReply, correctReply)
    }
  }
  assert.equal(calls, 0)
  assert.equal(learningEligibility({ buyerQuestion: 'Polo restock kab?', correctReply: 'ट्रैकिंग भेजता हूँ, 8 दिन में', timed: true }), 'transactional_reply')
  assert.equal(learningEligibility({ buyerQuestion: 'Polo restock kab?', correctReply: '8 दिन में', timed: true }), null)
  assert.equal(learningEligibility({ buyerQuestion: 'Which label is attached?', correctReply: 'केवल साइज लेबल लगा होता है।' }), null)
  assert.equal(learningEligibility({ buyerQuestion: 'Where do I edit my number?', correctReply: 'वेबसाइट पर अपना मोबाइल नंबर बदल सकते हैं।' }), null)
})

await test('outage preserves exact evidence before validation and never promotes', async () => {
  const db = fakeDb()
  const model = { messages: { create: async () => {
    assert.equal(db.rows.size, 1)
    throw new Error('outage')
  } } }
  const candidate = await validateLearningCandidate(db, model, input)
  assert.equal(candidate.verdict, 'pending')
  const row = db.rows.get(candidate.id)
  assert.equal(row.status, 'pending')
  assert.equal(row.payload.correctReply, input.correctReply)
  assert.equal(row.payload.author, 'human_owner')
  assert.equal(row.payload.evidence.sourceLogId, 'synthetic-log-1')
})
await test('explicit yes permits promotion; repeat evidence is idempotent', async () => {
  const db = fakeDb()
  const candidate = await validateLearningCandidate(db, fakeModel('YES'), input)
  assert.equal(candidate.verdict, 'accepted')
  await markLearningPromoted(db, candidate.id)
  const repeated = await validateLearningCandidate(db, fakeModel('', true), input)
  assert.equal(repeated.alreadyPromoted, true)
  assert.equal(db.rows.size, 1)
  await ensureLearningCandidates(db)
  assert.equal(db.events.filter(e => e === 'schema').length, 1)
})
await test('no rejects promotion but preserves original reply', async () => {
  const db = fakeDb()
  const result = await validateLearningCandidate(db, fakeModel('NO'), input)
  assert.equal(result.verdict, 'rejected')
  assert.equal(db.rows.get(result.id).payload.correctReply, input.correctReply)
})
await test('empty, ambiguous and truncated validator outputs await review', async () => {
  for (const text of ['', 'MAYBE', 'YES or NO', 'YES — same topic']) {
    assert.equal((await assessReplyPair(fakeModel(text), 'buyer', 'reply')).verdict, 'pending')
  }
  assert.equal((await assessReplyPair(fakeModel('YES', false, 'max_tokens'), 'buyer', 'reply')).verdict, 'pending')
})
await test('timing requires a real timing answer, not a ten-day stock assertion', async () => {
  const base = { buyerQuestion: 'Oversize 240gsm red available hai kya', timed: true }
  assert.equal(learningEligibility({ ...base, correctReply: 'Abhi available hai sir' }), 'not_stock_timing')
  assert.equal(learningEligibility({ ...base, correctReply: '8 se 10 din mein aayega sir' }), null)
  assert.equal(learningEligibility({ ...base, correctReply: 'बाहर देवली मσειल के लिए 8 दिन' }), 'garbled_transcript')
})
await test('timed facts use the pairing validator too', async () => {
  const db = fakeDb()
  const result = await validateLearningCandidate(db, fakeModel('NO'), { ...input, buyerQuestion: 'Oversize 240gsm red restock kab aayega', correctReply: '8 se 10 din mein', timed: true })
  assert.equal(result.verdict, 'rejected')
})
await test('media-dependent or garbled evidence stays pending without model spend', async () => {
  const model = { messages: { create: async () => { throw new Error('must not call') } } }
  for (const fields of [{ buyerQuestion: '[Image]' }, { correctReply: 'बाहर देवली मσειल के लिए' }]) {
    const result = await validateLearningCandidate(fakeDb(), model, { ...input, ...fields })
    assert.equal(result.verdict, 'pending')
  }
})
await test('unnamed timing stays pending even when the pair validator would say yes', async () => {
  let calls = 0
  const model = { messages: { create: async () => { calls++; return { content: [{ text: 'YES' }] } } } }
  for (const buyerQuestion of ['Kab tak out of stock hai?', 'Red M restock kab hoga?', 'When will it be available? [Image]', 'When will it be available? https://example.invalid/hoodie']) {
    const db = fakeDb()
    const result = await validateLearningCandidate(db, model, { ...input, buyerQuestion, correctReply: '11-13 दिन में आ जाना चाहिए', timed: true })
    assert.equal(result.verdict, 'pending')
    assert.equal(result.reason, 'missing_timing_subject')
    assert.equal(db.rows.get(result.id).payload.buyerQuestion, buyerQuestion)
  }
  assert.equal(calls, 0)
})
await test('named stock and launch subjects retain validated temporary learning', async () => {
  for (const buyerQuestion of ['Cotton Polo Grey restock kab hoga?', 'Reel dekhi women launch estimated time kya hai?', 'ग्रे पोलो out of stock कब तक है?']) {
    const result = await validateLearningCandidate(fakeDb(), fakeModel('YES'), { ...input, buyerQuestion, correctReply: '11-13 दिन में आ जाना चाहिए', timed: true })
    assert.equal(result.verdict, 'accepted', buyerQuestion)
  }
})
await test('ambiguous product timing stays pending with original evidence and no validator spend', async () => {
  let calls = 0
  const model = { messages: { create: async () => { calls++; throw Error('unexpected validation') } } }
  for (const [buyerQuestion, correctReply] of [
    ['240gsm restock kab hoga?', 'Try 210 instead; AcidWash needs 6-7 days.'],
    ['240gsm sizes restock kab hoga?', 'जो उपलब्ध है ले लो, बाकी एसिड वाश में 6-7 दिन लगेंगे।'],
    ['Polo restock kab hoga?', 'Hoodie in 6 days'],
    ['Polo and hoodie restock kab hoga?', 'Polo in 6 days'],
  ]) {
    const db = fakeDb()
    const result = await validateLearningCandidate(db, model, { ...input, buyerQuestion, correctReply, timed: true })
    assert.equal(result.verdict, 'pending', buyerQuestion)
    assert.equal(result.reason, 'ambiguous_timing_subject')
    assert.equal(db.rows.get(result.id).payload.correctReply, correctReply)
  }
  assert.equal(calls, 0)
})
await test('same-subject and subject-free owner timing remain eligible', async () => {
  for (const [buyerQuestion, correctReply] of [
    ['AcidWash 240gsm restock kab hoga?', 'Try 210 or 260 for now; AcidWash needs 6-7 days.'],
    ['AcidWash Oversize Black restock kab hoga?', '6-7 din mein aa jayega'],
    ['AcidWash restock kab hoga?', 'AcidWash Oversize in 6 days'],
    ['एसिड वाश restock कब होगा?', 'एसिड वाश में 6-7 दिन लगेंगे।'],
    ['Polo restock kab hoga?', 'Polo in 6 days'],
    ['Oversize 240gsm restock kab hoga?', '6 days'],
    ['240gsm restock kab hoga?', '6 days'],
  ]) {
    assert.equal(learningEligibility({ buyerQuestion, correctReply, timed: true }), null, buyerQuestion)
  }
})
await test('dated price changes never reach the validator or permanent promotion', async () => {
  let calls = 0
  const model = { messages: { create: async () => { calls++; throw Error('unexpected paid validation') } } }
  for (const fields of [
    { buyerQuestion: 'Why did the tshirt price rise?', correctReply: 'The price increased by ₹9 this week.' },
    { buyerQuestion: 'Rate itna kyun badha?', correctReply: 'Sir 6-9 rupaye ka fark aaya hai.' },
    { buyerQuestion: 'कीमत क्यों बढ़ी है?', correctReply: '११ रुपये का फ़रक आया है, पहले कम था।' },
    { buyerQuestion: 'How much did prices increase?', correctReply: 'Only 6-9 rupees sir' },
    { buyerQuestion: 'What changed in the catalogue?', correctReply: 'The price went from 121 to 129.' },
    { buyerQuestion: 'Polo restock kab hoga?', correctReply: 'Price increased by ₹9, stock in 8 days.', timed: true },
  ]) {
    const db = fakeDb()
    const result = await validateLearningCandidate(db, model, { ...input, ...fields })
    assert.equal(result.verdict, 'rejected', fields.correctReply)
    assert.equal(result.reason, 'perishable_price_answer')
    assert.equal(db.rows.get(result.id).payload.correctReply, fields.correctReply)
  }
  assert.equal(calls, 0)
})
await test('durable pricing instructions and non-price numbers keep their boundary', async () => {
  for (const fields of [
    { buyerQuestion: 'Why do prices change?', correctReply: 'Supplier costs can change; check current rates on the website.' },
    { buyerQuestion: 'How can I get the volume offer?', correctReply: '1000+ pcs in one order get ₹4/pc discount.' },
    { buyerQuestion: 'Why did the prices increase?', correctReply: '1000+ pcs in one order get ₹4/pc discount.' },
    { buyerQuestion: 'Explain the bulk discount policy', correctReply: 'For 1000+ pieces, the discount reduces the price by ₹4 per piece.' },
    { buyerQuestion: 'How much did prices increase?', correctReply: 'Check 240gsm samples on the website.' },
    { buyerQuestion: 'What is the difference in these shirts?', correctReply: 'One is 180gsm and the other is 240gsm.' },
    { buyerQuestion: 'Why are these rates different?', correctReply: 'The website explains the difference: https://example.invalid/rates/9' },
  ]) assert.equal(learningEligibility(fields), null, fields.correctReply)
})
await test('subject only in an answer requires review before compact timing reuse', async () => {
  assert.equal(learningEligibility({ buyerQuestion: 'When will it be available?', correctReply: 'Cotton Polo Grey in 11-13 days', timed: true }), 'missing_timing_subject')
})
await test('unsafe legacy bulk promotion is disabled', async () => {
  assert.equal(legacyCorrectionBackfillResponse().status, 'disabled')
})
await test('AI suggestions never acquire human provenance or permission to promote', async () => {
  const db = fakeDb()
  const result = await validateLearningCandidate(db, fakeModel('YES'), { ...input, origin: 'reviewer_ai' })
  assert.equal(result.verdict, 'rejected')
  assert.equal(result.reason, 'untrusted_origin')
  assert.equal(db.rows.get(result.id).payload.author, 'unverified')
})
console.log(`${tests} candidate tests passed`)
