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
  const base = { buyerQuestion: 'red available hai kya', timed: true }
  assert.equal(learningEligibility({ ...base, correctReply: 'Abhi available hai sir' }), 'not_stock_timing')
  assert.equal(learningEligibility({ ...base, correctReply: '8 se 10 din mein aayega sir' }), null)
  assert.equal(learningEligibility({ ...base, correctReply: 'बाहर देवली मσειल के लिए 8 दिन' }), 'garbled_transcript')
})
await test('timed facts use the pairing validator too', async () => {
  const db = fakeDb()
  const result = await validateLearningCandidate(db, fakeModel('NO'), { ...input, buyerQuestion: 'red restock kab aayega', correctReply: '8 se 10 din mein', timed: true })
  assert.equal(result.verdict, 'rejected')
})
await test('media-dependent or garbled evidence stays pending without model spend', async () => {
  const model = { messages: { create: async () => { throw new Error('must not call') } } }
  for (const fields of [{ buyerQuestion: '[Image]' }, { correctReply: 'बाहर देवली मσειल के लिए' }]) {
    const result = await validateLearningCandidate(fakeDb(), model, { ...input, ...fields })
    assert.equal(result.verdict, 'pending')
  }
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
