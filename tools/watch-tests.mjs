import assert from 'node:assert/strict'
import { assessPulse } from './watch-pulse.mjs'

const healthy = () => ({ health: { status: 'ok', db: 'connected' }, settings: { isActive: true, dailySpentUsd: 1, dailyBudgetInr: 1500 }, inbox: { ok: true, stuck: 0, oldestPendingSec: 0 }, poll: { ok: true, ig: { ageSec: 60 }, yt: [{ enabled: true, ageSec: 60 }] }, logs: [], inbound: [], errors: {} })
const codes = data => assessPulse(data).problems.map(row => row.code)
assert.deepEqual(codes(healthy()), [])
assert(codes({ ...healthy(), logs: [{ status: 'FAILED' }] }).includes('failed-replies'))
assert(codes({ ...healthy(), errors: { logs: 'HTTP 401 from /api/logs' } }).includes('endpoint-logs'))
assert(codes({ ...healthy(), poll: { ok: false } }).includes('comment-health'))
assert(codes({ ...healthy(), poll: { ok: true, ig: { ageSec: 901 } } }).includes('instagram-poller'))
assert(codes({ ...healthy(), inbox: { ok: true, stuck: 1 } }).includes('inbox-stuck'))
assert(codes({ ...healthy(), logs: [{ deferReason: 'daily_limit' }] }).includes('budget-tripped'))
assert(codes({ ...healthy(), logs: [{ deferReason: 'all_claude_models_failed' }] }).includes('provider-fallback'))
const inbound = [{ id: 'test-1', whatsappId: 'wamid.test-1', createdAt: new Date(Date.now() - 4 * 60000).toISOString() }]
assert(codes({ ...healthy(), inbound }).includes('inbound-without-outcome'))
assert(!codes({ ...healthy(), inbound, logs: [{ status: 'SKIPPED', messageIds: ['test-1'] }] }).includes('inbound-without-outcome'))
assert(!codes({ ...healthy(), inbound: [{ ...inbound[0], createdAt: new Date().toISOString() }] }).includes('inbound-without-outcome'))
assert(!codes({ ...healthy(), poll: { ok: true, ig: { pollEnabled: false }, yt: [{ enabled: false }] } }).includes('instagram-poller'))
assert(codes({ ...healthy(), inbound, logs: [{ status: 'REPLIED', sentViaWwbun: true, messageIds: ['someone-else'] }] }).includes('inbound-without-outcome'))
assert(codes({ ...healthy(), logs: [{ status: 'DEFERRED', deferReason: 'post_model_guard_failed' }] }).includes('post-model-guard-failed'))
const differingRate = { ...healthy(), settings: { dailySpentUsd: 17.2, dailyBudgetInr: 1500, usdToInr: 88, dailyJobSpentUsd: 2 } }
assert(codes(differingRate).includes('budget-tripped'))
assert(!codes({ ...healthy(), settings: { dailySpentUsd: 1, dailyBudgetInr: 1500, usdToInr: 88, dailyJobSpentUsd: 100 } }).includes('budget-tripped'))
assert.equal(assessPulse(differingRate).budget.jobInr, 176)
console.log('17 watch fault/control checks passed')
