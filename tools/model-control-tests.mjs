import assert from 'node:assert/strict'
import { createModelControl, modelEligibility, publicModelUse, assessModelOutput } from '../server/model-control.js'
import { modelUsageCost } from '../server/reply-models.js'

let checks = 0
async function check(name, run) { await run(); checks++; console.log('PASS ' + name) }
const at = Date.parse('2026-09-23T06:00:00.000Z')
const capabilities = () => ({ image_input: { supported: true }, thinking: { types: { adaptive: { supported: true } } }, effort: { low: { supported: true } } })
const listed = (id, created_at = '2026-09-22T00:00:00Z') => ({ id, created_at, capabilities: capabilities() })
const usage = () => ({ input_tokens: 100, output_tokens: 80, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } })
const ready = model => ({ id: 'PRIVATE_REQUEST_ID', model, stop_reason: 'end_turn', usage: usage(), content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' }, { type: 'text', text: 'READY' }] })

function fixture({ selected = 'claude-opus-5', available, onSwitch } = {}) {
  const data = {
    clock: at,
    settings: { id: 'default', replyModel: selected, replyModelSetAt: new Date(at - 10000), dailyJobSpentUsd: 0 },
    listRows: available || [listed('claude-opus-5', '2026-07-24T00:00:00Z'), listed('claude-opus-5-5'), listed('claude-future-6', '2026-09-23T00:00:00Z')],
    rows: [], listCalls: [], probeCalls: [], charges: [], switches: [], queries: [], switched: 0,
  }
  const db = {
    settings: {
      async findUnique() { return data.settings ? { ...data.settings } : null },
      async update({ data: update }) {
        if (data.chargeFailure) throw Error('PRIVATE_DB_FAILURE')
        const cost = update.dailyJobSpentUsd.increment
        assert.ok(Number.isFinite(cost) && cost >= 0)
        data.charges.push(cost); data.settings.dailyJobSpentUsd += cost
      },
      async updateMany(query) {
        data.switches.push(query)
        if (data.beforeCas) await data.beforeCas()
        const same = query.where.replyModel === data.settings.replyModel && +new Date(query.where.replyModelSetAt) === +new Date(data.settings.replyModelSetAt)
        if (!same) return { count: 0 }
        Object.assign(data.settings, query.data)
        return { count: 1 }
      },
    },
    async $queryRawUnsafe(query) {
      data.queries.push(query)
      if (data.historyFailure) throw Error('PRIVATE_QUERY_FAILURE')
      return data.rows
    },
  }
  const anthropic = {
    models: { list(...args) {
      data.listCalls.push(args)
      return { async *[Symbol.asyncIterator]() {
        if (data.listFailure) throw Error('PRIVATE_PROVIDER_FAILURE')
        for (const row of data.listRows) yield row
        if (data.partialListFailure) throw Error('PRIVATE_PAGINATION_FAILURE')
      } }
    } },
    messages: { async create(params, options) {
      data.probeCalls.push({ params, options })
      return data.probe ? data.probe(params) : ready(params.model)
    } },
  }
  const control = createModelControl({ db, anthropic, now: () => data.clock, onSwitch: onSwitch || (() => { data.switched++ }) })
  return { data, control }
}

await check('future API-listed compatible models appear and are explicitly estimated', async () => {
  const { data, control } = fixture()
  const state = await control.state()
  const future = state.available.find(m => m.id === 'claude-future-6')
  assert.equal(future.selectable, true); assert.equal(future.live, true); assert.equal(future.newer, true)
  assert.equal(future.pricing.estimated, true); assert.equal(future.pricing.verified, false)
  assert.equal(state.current, 'claude-opus-5'); assert.equal(state.badge, true)
  assert.equal(data.probeCalls.length, 0)
})
await check('future models require provider-confirmed image, adaptive thinking and low effort', async () => {
  for (const change of [m => { delete m.capabilities }, m => { m.capabilities.image_input.supported = false }, m => { m.capabilities.thinking.types.adaptive.supported = false }, m => { m.capabilities.effort.low.supported = false }]) {
    const model = listed('claude-future-6'); change(model)
    assert.match(modelEligibility(model), /not confirmed/)
    const { data, control } = fixture({ available: [model] })
    assert.equal((await control.state()).available.find(m => m.id === model.id).selectable, false)
    await assert.rejects(control.switchTo(model.id), e => e.status === 400)
    assert.equal(data.probeCalls.length, 0); assert.equal(data.settings.replyModel, 'claude-opus-5')
  }
})
await check('known models remain compatible when the API omits capability metadata', async () => {
  const { data, control } = fixture({ available: [{ id: 'claude-opus-5-5', created_at: '2026-09-22' }] })
  assert.equal((await control.state()).available.find(m => m.id === 'claude-opus-5-5').selectable, true)
  await control.switchTo('claude-opus-5-5'); assert.equal(data.settings.replyModel, 'claude-opus-5-5')
})
await check('unlisted or invalid IDs cannot activate or invoke the paid probe', async () => {
  const { data, control } = fixture()
  for (const id of ['claude-future-999', 'not-a-model', 'claude-opus-5-5\n']) await assert.rejects(control.switchTo(id), e => e.status === 400)
  assert.equal(data.probeCalls.length, 0); assert.equal(data.switches.length, 0); assert.equal(data.settings.replyModel, 'claude-opus-5')
})
await check('catalogue cache lasts 15 minutes and explicit refresh bypasses it', async () => {
  const { data, control } = fixture()
  await control.state(); data.clock += 15 * 60000 - 1; await control.state()
  assert.equal(data.listCalls.length, 1)
  data.clock++; await control.state(); assert.equal(data.listCalls.length, 2)
  await control.state(true); assert.equal(data.listCalls.length, 3)
  assert.equal(data.listCalls[0][1].timeout, 15000); assert.equal(data.listCalls[0][1].maxRetries, 0)
})
await check('provider failure preserves the selected future model and marks stale choices unavailable', async () => {
  const { data, control } = fixture({ selected: 'claude-future-6' })
  await control.state(); data.listFailure = true
  const state = await control.state(true)
  assert.equal(state.current, 'claude-future-6'); assert.equal(state.catalogStale, true)
  assert.equal(state.available.every(m => !m.selectable && !m.live), true)
  assert.deepEqual(state.detectedNew, []); assert.equal(state.badge, false)
  await assert.rejects(control.switchTo('claude-opus-5-5'), e => e.status === 502 && !e.message.includes('PRIVATE'))
  assert.equal(data.settings.replyModel, 'claude-future-6'); assert.equal(data.probeCalls.length, 0)
})
await check('initial provider failure does not invent availability for the selected model', async () => {
  const { data, control } = fixture({ selected: 'claude-future-6' }); data.listFailure = true
  const state = await control.state()
  assert.equal(state.current, 'claude-future-6'); assert.equal(state.catalogCheckedAt, null)
  assert.equal(state.available.find(m => m.id === state.current).selectable, false)
  assert.equal(state.lastReply, null); assert.equal(state.catalogStale, true)
})
await check('partial pagination failure and empty provider catalogue preserve the previous full catalogue', async () => {
  for (const empty of [false, true]) {
    const { data, control } = fixture(); await control.state()
    data.listRows = empty ? [] : [listed('claude-partial-99')]; data.partialListFailure = !empty
    const state = await control.state(true)
    assert.equal(state.catalogStale, true)
    assert.equal(state.available.some(m => m.id === 'claude-partial-99'), false)
    assert.equal(state.available.some(m => m.id === 'claude-future-6'), true)
  }
})
await check('successful switch uses compatible parameters, charges the job counter and records API verification', async () => {
  const { data, control } = fixture()
  const result = await control.switchTo('claude-opus-5-5')
  assert.equal(result.ok, true); assert.equal(result.verifiedModel, 'claude-opus-5-5')
  const call = data.probeCalls[0]
  assert.equal(call.params.thinking.type, 'adaptive'); assert.equal(call.params.output_config.effort, 'low')
  assert.equal(call.options.maxRetries, 0); assert.equal(call.options.timeout, 40000)
  assert.equal(data.charges[0], modelUsageCost('claude-opus-5-5', usage()).costUsd)
  assert.equal(data.settings.dailyJobSpentUsd, data.charges[0]); assert.equal(data.switched, 1)
  const state = await control.state()
  assert.equal(state.verification.status, 'api_test_passed'); assert.equal(state.lastReply, null)
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
})
await check('future compatibility probe is allowed without a code allow-list addition', async () => {
  const { data, control } = fixture()
  await control.switchTo('claude-future-6')
  assert.equal(data.settings.replyModel, 'claude-future-6')
  assert.equal(data.probeCalls[0].params.thinking.type, 'adaptive')
  assert.equal(data.charges[0], modelUsageCost('claude-future-6', usage()).costUsd)
  assert.equal((await control.state()).currentPricing.estimated, true)
})
for (const [name, response] of [
  ['wrong returned model', () => ready('claude-opus-5')],
  ['truncated answer', model => ({ ...ready(model), stop_reason: 'max_tokens' })],
  ['refusal', model => ({ ...ready(model), stop_reason: 'refusal' })],
  ['thinking-only answer', model => ({ ...ready(model), content: [{ type: 'thinking', thinking: 'PRIVATE' }] })],
  ['wrong readiness text', model => ({ ...ready(model), content: [{ type: 'text', text: 'I cannot answer PRIVATE_REQUEST' }] })],
]) await check(`${name} charges the completed probe but never activates`, async () => {
  const { data, control } = fixture(); data.probe = params => response(params.model)
  await assert.rejects(control.switchTo('claude-opus-5-5'), e => e.status === 502 && !e.message.includes('PRIVATE'))
  assert.equal(data.settings.replyModel, 'claude-opus-5'); assert.equal(data.charges.length, 1)
  assert.equal(data.switches.length, 0); assert.equal(data.switched, 0)
  assert.equal((await control.state()).verification, null)
})
await check('provider errors preserve selection and release the same-process switch lock', async () => {
  const { data, control } = fixture(); data.probe = () => { throw Error('PRIVATE_API_KEY') }
  await assert.rejects(control.switchTo('claude-opus-5-5'), e => e.status === 502 && !e.message.includes('PRIVATE'))
  assert.equal(data.charges.length, 0); assert.equal(data.settings.replyModel, 'claude-opus-5')
  data.probe = null; assert.equal((await control.switchTo('claude-opus-5-5')).ok, true)
})
await check('job charge failure prevents activation', async () => {
  const { data, control } = fixture(); data.chargeFailure = true
  await assert.rejects(control.switchTo('claude-opus-5-5'))
  assert.equal(data.switches.length, 0); assert.equal(data.settings.replyModel, 'claude-opus-5')
})
await check('different explicit dated snapshot cannot pass as the requested model', async () => {
  const id = 'claude-future-6-20260923'
  const { data, control } = fixture({ available: [listed(id)] })
  data.probe = () => ready('claude-future-6-20260922')
  await assert.rejects(control.switchTo(id), e => e.status === 502)
  assert.equal(data.settings.replyModel, 'claude-opus-5'); assert.equal(data.charges.length, 1)
})
await check('canonical model aliases can return the provider-listed dated model', async () => {
  const { data, control } = fixture({ available: [listed('claude-opus-5-5-20260922')] })
  data.probe = () => ready('claude-opus-5-5-20260922')
  const result = await control.switchTo('claude-opus-5-5')
  assert.equal(result.verifiedModel, 'claude-opus-5-5-20260922'); assert.equal(data.settings.replyModel, 'claude-opus-5-5')
})
await check('CAS preserves an external switch made during the probe', async () => {
  const { data, control } = fixture()
  data.probe = params => { data.settings.replyModel = 'claude-future-6'; data.settings.replyModelSetAt = new Date(at + 1); return ready(params.model) }
  await assert.rejects(control.switchTo('claude-opus-5-5'), e => e.status === 409)
  assert.equal(data.settings.replyModel, 'claude-future-6'); assert.equal(data.charges.length, 1); assert.equal(data.switched, 0)
})
await check('CAS also detects switching away and back to the same model', async () => {
  const { data, control } = fixture()
  data.beforeCas = () => { data.settings.replyModelSetAt = new Date(at + 1) }
  await assert.rejects(control.switchTo('claude-opus-5-5'), e => e.status === 409)
  assert.equal(data.settings.replyModel, 'claude-opus-5')
})
await check('a second same-process switch is rejected before its provider probe', async () => {
  const { data, control } = fixture()
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  data.probe = params => new Promise(resolve => { release = () => resolve(ready(params.model)); started() })
  const first = control.switchTo('claude-opus-5-5'); await waiting
  await assert.rejects(control.switchTo('claude-future-6'), e => e.status === 409)
  assert.equal(data.probeCalls.length, 1); release(); assert.equal((await first).ok, true)
})
await check('old process-local verification cannot be shown for a newer external selection', async () => {
  const { data, control } = fixture(); await control.switchTo('claude-opus-5-5')
  data.settings.replyModel = 'claude-future-6'; data.settings.replyModelSetAt = new Date(at + 1)
  assert.equal((await control.state()).verification, null)
  data.settings.replyModel = 'claude-opus-5-5'
  assert.equal((await control.state()).verification, null)
})
await check('last reply reports actual response model and is never inferred from the selected model', async () => {
  const { data, control } = fixture({ selected: 'claude-opus-5-5' })
  data.rows = [{ createdAt: new Date(at - 500), modelUse: { requestedModel: 'claude-opus-5-5', responseModel: 'claude-opus-5', fallback: true, rewrite: { changed: true, responseModel: 'claude-haiku-4-5-20251001' }, requestId: 'PRIVATE_REQUEST_ID', prompt: 'PRIVATE_BUYER_PROMPT' } }]
  const state = await control.state()
  assert.equal(state.current, 'claude-opus-5-5'); assert.equal(state.lastReply.model, 'claude-opus-5'); assert.equal(state.lastReply.fallback, true)
  assert.equal(state.lastReply.rewriteModel, 'claude-haiku-4-5-20251001')
  assert.equal(JSON.stringify(state).includes('PRIVATE'), false)
  assert.match(data.queries[0], /status = 'REPLIED'/); assert.match(data.queries[0], /"sentViaWwbun" = true/)
  assert.doesNotMatch(data.queries[0], /responseModel.*IS NOT NULL/)
})
await check('unproven response identity or unavailable history remains unknown', async () => {
  const { data, control } = fixture()
  data.rows = [{ createdAt: new Date(at), modelUse: { requestedModel: 'claude-opus-5-5' } }]
  assert.equal((await control.state()).lastReply, null)
  assert.doesNotMatch(data.queries.at(-1), /responseModel.*IS NOT NULL/)
  data.historyFailure = true
  const state = await control.state(); assert.equal(state.lastReply, null); assert.equal(state.statusStale, true)
  assert.equal(JSON.stringify(state).includes('PRIVATE'), false)
})
await check('public metadata rejects nested prompt/request-ID objects in every model field', () => {
  const output = publicModelUse({ createdAt: new Date(at), modelUse: { responseModel: 'claude-opus-5-5', requestedModel: { prompt: 'PRIVATE' }, rewrite: { changed: true, responseModel: { requestId: 'PRIVATE' }, requestedModel: 'PRIVATE_PROMPT' }, buyerText: 'PRIVATE', requestId: 'PRIVATE' } })
  assert.equal(output.requestedModel, null); assert.equal(output.rewriteModel, null)
  assert.equal(JSON.stringify(output).includes('PRIVATE'), false)
  assert.equal(publicModelUse({ modelUse: { responseModel: { text: 'PRIVATE' } } }), null)
})

const outputRow = (model, words, extra = {}) => ({ modelUse: { requestedModel: model, responseModel: model }, status: 'REPLIED', sentViaWwbun: true, costUsd: .01, aiReply: Array(words).fill('word').join(' '), completionTokens: 9000, ...extra })
await check('self-protection ignores hidden output tokens and other actual response models', () => {
  const own = Array.from({ length: 12 }, () => outputRow('claude-opus-5-5', 20))
  const other = Array.from({ length: 20 }, () => outputRow('claude-opus-5', 150, { modelUse: { requestedModel: 'claude-opus-5-5', responseModel: 'claude-opus-5' } }))
  const result = assessModelOutput([...own, ...other], 'claude-opus-5-5')
  assert.equal(result.replies, 12); assert.equal(result.avgWords, 20); assert.equal(result.revert, false)
})
await check('self-protection counts genuine visible verbosity and matching leak deferrals', () => {
  assert.equal(assessModelOutput(Array.from({ length: 8 }, () => outputRow('claude-opus-5-5', 75)), 'claude-opus-5-5').revert, true)
  const leaks = Array.from({ length: 4 }, () => outputRow('claude-opus-5-5', 0, { status: 'DEFERRED', deferReason: 'reasoning_leak_blocked' }))
  assert.equal(assessModelOutput(leaks, 'claude-opus-5-5').revert, true)
  assert.equal(assessModelOutput(leaks, 'claude-opus-5').leakDeferrals, 0)
})
await check('self-protection excludes unsent/free rows and URL length from buyer verbosity', () => {
  const rows = Array.from({ length: 20 }, () => outputRow('claude-opus-5-5', 150, { sentViaWwbun: false }))
  rows.push(...Array.from({ length: 20 }, () => outputRow('claude-opus-5-5', 150, { costUsd: 0 })))
  rows.push(outputRow('claude-opus-5-5-20260922', 0, { aiReply: 'Available sir https://example.invalid/' + 'long'.repeat(200) }))
  const result = assessModelOutput(rows, 'claude-opus-5-5')
  assert.equal(result.replies, 1); assert.equal(result.avgWords, 2); assert.equal(result.revert, false)
})

await check('rule-generated paid rows are excluded from status and self-protection', async () => {
  const { data, control } = fixture()
  const rule = outputRow('claude-opus-5-5', 180, { modelUse: { responseModel: 'claude-opus-5-5', outputSource: 'rule' } })
  data.rows = [rule]
  assert.equal((await control.state()).lastReply, null)
  assert.match(data.queries[0], /outputSource.*IS DISTINCT FROM 'rule'/)
  assert.equal(publicModelUse(rule), null)
  assert.equal(assessModelOutput(Array(12).fill(rule), 'claude-opus-5-5').replies, 0)
})
await check('a requested-only rewrite is not claimed as an actual provider response', () => {
  const row = { modelUse: { responseModel: 'claude-opus-5-5', rewrite: { changed: true, requestedModel: 'claude-haiku-4-5-20251001' } } }
  assert.equal(publicModelUse(row).rewriteModel, null)
})
await check('a pinned unavailable date stays selected rather than marking a different date current', async () => {
  const selected = 'claude-future-6-20260922'
  const { control } = fixture({ selected, available: [listed('claude-future-6-20260923')] })
  const state = await control.state()
  assert.equal(state.current, selected)
  assert.deepEqual(state.available.filter(m => m.current).map(m => m.id), [selected])
  assert.equal(state.available.find(m => m.current).selectable, false)
  assert.equal(state.available.find(m => m.id === 'claude-future-6-20260923').current, false)
})
await check('canonical selections recognize dated provider IDs but pinned self-protection requires exact date', async () => {
  const { control } = fixture({ selected: 'claude-opus-5-5', available: [listed('claude-opus-5-5-20260922')] })
  assert.equal((await control.state()).available.find(m => m.id === 'claude-opus-5-5-20260922').current, true)
  const rows = Array.from({ length: 12 }, () => outputRow('claude-opus-5-5-20260922', 100))
  assert.equal(assessModelOutput(rows, 'claude-opus-5-5').revert, true)
  assert.equal(assessModelOutput(rows, 'claude-opus-5-5-20260923').revert, false)
})
await check('leak frequency counts all matching outcomes rather than only the 30 verbosity samples', () => {
  const rows = Array.from({ length: 190 }, () => outputRow('claude-opus-5-5', 20))
  rows.push(...Array.from({ length: 8 }, () => outputRow('claude-opus-5-5', 0, { status: 'DEFERRED', deferReason: 'reasoning_leak_blocked' })))
  const result = assessModelOutput(rows, 'claude-opus-5-5')
  assert.equal(result.replies, 30); assert.equal(result.leakDeferrals, 8); assert.equal(result.revert, false)
})

console.log(`${checks} model-control checks passed`)
