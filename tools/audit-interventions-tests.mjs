import assert from 'node:assert/strict'
import { buildAudit, isAcknowledgment } from './audit-interventions-lib.mjs'

const epoch = Date.parse('2026-09-10T00:00:00Z')
const row = (id, minute, status, deferReason, extra = {}) => ({
  id, createdAt: new Date(epoch + minute * 60000).toISOString(), status, deferReason,
  conversationId: 'fixture-conversation', conversation: { id: 'fixture-conversation', whatsappNumber: 'fixture-buyer' },
  buyerMessage: 'Question?', aiReply: status === 'REPLIED' ? 'Answer' : '', costUsd: status === 'REPLIED' ? 0.02 : 0, ...extra,
})
let pass = 0
function test(name, run) { run(); pass++; console.log(`PASS ${name}`) }
test('nearest reply owns one follow-up, not every earlier reply', () => {
  const a = buildAudit([row('a', 0, 'REPLIED'), row('b', 1, 'REPLIED'), row('m', 2, 'SKIPPED', 'manual_reply', { aiReply: 'Correct answer' })])
  assert.deepEqual(a.interventions.map(x => x.logId), ['b'])
})
test('defer stops attribution to previous successful reply', () => {
  const a = buildAudit([row('a', 0, 'REPLIED'), row('d', 1, 'DEFERRED', 'claude_deferred'), row('m', 2, 'SKIPPED', 'manual_reply', { aiReply: 'I will handle the refund' })])
  assert.equal(a.interventions.length, 0)
  assert.equal(a.manualCandidates[0].category, 'defer_followup')
})
test('new silent buyer turn remains visible as a silence follow-up', () => {
  const a = buildAudit([row('a', 0, 'REPLIED'), row('s', 1, 'SKIPPED', 'ai_chose_silence', { buyerMessage: 'The requested address' }), row('m', 2, 'SKIPPED', 'manual_reply', { aiReply: 'I booked the replacement' })])
  assert.equal(a.interventions.length, 0)
  assert.equal(a.manualCandidates[0].category, 'silence_followup')
})
test('housekeeping does not hide a real reply follow-up', () => {
  const a = buildAudit([row('a', 0, 'REPLIED'), row('h', 1, 'SKIPPED', 'welcome_followup_scheduled'), row('m', 2, 'SKIPPED', 'manual_reply', { aiReply: 'Correct answer' })])
  assert.equal(a.interventions[0].logId, 'a')
})
test('buyer acknowledgment between reply and correction does not erase attribution', () => {
  const a = buildAudit([row('a', 0, 'REPLIED'), row('s', 1, 'SKIPPED', 'ai_chose_silence', { buyerMessage: 'Ok' }), row('m', 2, 'SKIPPED', 'manual_reply', { aiReply: 'Correct answer' })])
  assert.equal(a.interventions[0].logId, 'a')
})
test('bare owner acknowledgments and emoji are excluded, substantive thanks retained', () => {
  for (const text of ['Ok sir 🙏', '🙏🙂', 'Thank you', 'Ji']) assert.equal(isAcknowledgment(text), true)
  assert.equal(isAcknowledgment('Thanks, but the rate is different'), false)
  const a = buildAudit([row('a', 0, 'REPLIED'), row('m', 1, 'SKIPPED', 'manual_reply', { aiReply: 'Ok' })])
  assert.equal(a.interventions.length, 0)
  assert.equal(a.stats.acknowledgmentCount, 1)
})
test('owner multi-message replies do not multiply interventions', () => {
  const a = buildAudit([row('a', 0, 'REPLIED'), row('m', 1, 'SKIPPED', 'manual_reply', { aiReply: 'Correction part one' }), row('n', 2, 'SKIPPED', 'manual_reply', { aiReply: 'Correction part two' })])
  assert.equal(a.interventions.length, 1)
  assert.equal(a.stats.unpairedManualCount, 1)
})
test('free canned replies are not called paid', () => {
  const a = buildAudit([row('a', 0, 'REPLIED', 'canned', { costUsd: 0 }), row('m', 1, 'SKIPPED', 'manual_reply', { aiReply: 'Correction' })])
  assert.equal(a.stats.paidReplies, 0)
  assert.equal(a.interventions[0].paid, false)
})
test('duplicate pages and separate conversations never duplicate or cross-pair', () => {
  const a = row('a', 0, 'REPLIED')
  const m = row('m', 1, 'SKIPPED', 'manual_reply', { aiReply: 'Correction', conversation: { id: 'other' } })
  const audit = buildAudit([a, a, m])
  assert.equal(audit.stats.rows, 2)
  assert.equal(audit.interventions.length, 0)
})
test('long gaps never become intervention pairs', () => {
  const a = buildAudit([row('a', 0, 'REPLIED'), row('m', 181, 'SKIPPED', 'manual_reply', { aiReply: 'Other topic' })])
  assert.equal(a.interventions.length, 0)
})
test('media is flagged, full context never falsely certified by lite logs', () => {
  const a = buildAudit([row('a', 0, 'REPLIED', null, { buyerMessage: '[Audio] [Image]', promptSent: { omitted: true } }), row('m', 1, 'SKIPPED', 'manual_reply', { aiReply: 'Correction' })])
  const c = a.interventions[0].context
  assert.equal(c.mediaMarkersPresent, true)
  assert.equal(c.fullContextAvailable, false)
  assert.equal(c.mediaReview, 'not_checked')
  assert.equal(c.promptSnapshotAvailable, true)
})
test('unpaired silence, defer and factual replies are sampled without grading', () => {
  const a = buildAudit([row('s', 0, 'SKIPPED', 'ai_chose_silence'), row('d', 1, 'DEFERRED'), row('r', 2, 'REPLIED', null, { aiReply: 'Restock in one week' })])
  assert.equal(a.samples.length, 3)
  assert.ok(a.samples.every(s => s.reviewStatus === 'unreviewed_candidate' && s.manualLogId === null))
})
test('window boundary retains preceding context without inflating totals', () => {
  const a = buildAudit([row('a', 0, 'REPLIED'), row('m', 2, 'SKIPPED', 'manual_reply', { aiReply: 'Correction' })], { since: epoch + 60000 })
  assert.equal(a.stats.rows, 1)
  assert.equal(a.interventions[0].logId, 'a')
})
console.log(`${pass} audit tests passed`)
