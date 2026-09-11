import assert from 'node:assert/strict'
import { summarizeLearningCandidates, renderCandidateReport } from './review-learning-candidates.mjs'

const candidate = (id, status = 'pending', fields = {}) => ({ id, status, origin: 'edit', reason: 'validator_unavailable', createdAt: '2026-09-10T12:00:00Z', payload: { author: 'human_owner', buyerQuestion: 'Can I mix?', correctReply: 'Yes, mix colours', evidence: { manualLogId: 'synthetic-log' } }, ...fields })
let pass = 0
const test = (name, check) => { check(); pass++; console.log(`PASS ${name}`) }
test('separate pending, rejected, validated and promoted counts', () => {
  const states = ['pending', 'rejected', 'validated', 'promoted']
  const report = summarizeLearningCandidates({ rows: states.map((s, i) => candidate(`id${i}`, s)), counts: states.map(status => ({ status, count: 1 })) })
  assert.equal(report.coverageComplete, true)
  assert.equal(report.actionNeeded, true)
  assert.equal(report.autoPromotion, false)
  assert.deepEqual(report.counts, { pending: 1, rejected: 1, validated: 1, promoted: 1, unknown: 0 })
})
test('capped endpoint never reports a clean complete audit', () => {
  const report = summarizeLearningCandidates({ rows: [candidate('id1')], counts: [{ status: 'pending', count: 201 }] })
  assert.equal(report.coverageComplete, false)
  assert.match(renderCandidateReport(report), /INCOMPLETE/)
})
test('portable output excludes raw secrets, text and arbitrary metadata', () => {
  const secret = 'fixture-password-private-value'
  const report = summarizeLearningCandidates({ rows: [candidate('id1', 'pending', { reason: secret, origin: secret, payload: { correctReply: secret, buyerQuestion: secret, evidence: { secret, fullAddress: secret, sourceLogId: secret + '@example.test' } } })], counts: [{ status: 'pending', count: 1 }] })
  assert.equal(JSON.stringify(report).includes(secret), false)
  assert.equal(renderCandidateReport(report).includes(secret), false)
  assert.equal(report.entries[0].reason, 'other_reason')
  assert.equal(report.entries[0].origin, 'unverified')
})
test('normalized repeated pair grouped but different answer remains separate', () => {
  const a = candidate('a'), b = candidate('b'), c = candidate('c')
  b.payload = { ...b.payload, buyerQuestion: ' CAN  I MIX? ', correctReply: 'yes, mix colours' }
  c.payload = { ...c.payload, correctReply: 'No, only one colour' }
  const report = summarizeLearningCandidates({ rows: [a, b, c], counts: [{ status: 'pending', count: 3 }] })
  assert.equal(report.repeatedPairs.length, 1)
  assert.deepEqual(report.repeatedPairs[0].candidateIds, ['a', 'b'])
  assert.notEqual(report.entries[0].payloadSha256, report.entries[1].payloadSha256)
})
test('malformed API shape and invalid totals fail visibly', () => {
  assert.throws(() => summarizeLearningCandidates({ rows: [] }), /invalid shape/)
  assert.throws(() => summarizeLearningCandidates({ rows: [], counts: [{ status: 'pending', count: -1 }] }), /invalid count/)
})
test('empty store is complete and needs no promotions', () => {
  const report = summarizeLearningCandidates({ rows: [], counts: [] })
  assert.equal(report.coverageComplete, true)
  assert.equal(report.actionNeeded, false)
  assert.equal(report.inspectedRows, 0)
})
test('human provenance is not invented for an unverified source', () => {
  const report = summarizeLearningCandidates({ rows: [candidate('id1', 'pending', { payload: { author: 'unverified' } })], counts: [{ status: 'pending', count: 1 }] })
  assert.equal(report.entries[0].author, 'unverified')
})
console.log(`${pass} candidate-review tests passed`)
