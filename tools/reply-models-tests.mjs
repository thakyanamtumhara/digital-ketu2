import assert from 'node:assert/strict'
import { BASELINE_REPLY_MODEL, REPLY_MODEL_INFO, baseModelId, validReplyModelId, resolveReplyModel, replyModelParams, responseText, modelPricing, modelUsageCost } from '../server/reply-models.js'

let checks = 0
function check(name, run) { run(); checks++; console.log('PASS ' + name) }
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)
const legacy = ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7']
const adaptive = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-future-9']

check('trusted baseline and named model options stay explicit', () => {
  assert.equal(BASELINE_REPLY_MODEL, 'claude-opus-5')
  assert.equal(REPLY_MODEL_INFO.default, BASELINE_REPLY_MODEL)
  assert.deepEqual(REPLY_MODEL_INFO.allow, ['claude-opus-5-5', ...legacy, 'claude-fable-5-1'])
  assert.equal(REPLY_MODEL_INFO.labels['claude-opus-5-5'], 'Opus 5.5')
})
check('valid saved future and legacy models are preserved verbatim', () => {
  for (const model of [...legacy, ...adaptive, 'claude-opus-5-5-20260922', 'claude-sonnet-4-6']) assert.equal(resolveReplyModel({ replyModel: model }), model)
})
check('invalid or missing saved models fall back to the baseline', () => {
  for (const value of [null, undefined, '', 'gpt-6', 'claude-', 'claude-5', 'claude-Opus-5', ' claude-opus-5', 'claude-opus-5\n', 'claude-opus-5/test', 'claude-' + 'a'.repeat(94), {}, 55]) {
    assert.equal(validReplyModelId(value), false)
    assert.equal(resolveReplyModel({ replyModel: value }), BASELINE_REPLY_MODEL)
  }
  assert.equal(resolveReplyModel(null), BASELINE_REPLY_MODEL)
  assert.equal(resolveReplyModel(), BASELINE_REPLY_MODEL)
  assert.equal(validReplyModelId('claude-' + 'a'.repeat(93)), true)
})
check('base IDs strip only a trailing eight-digit date', () => {
  assert.equal(baseModelId('claude-opus-5-5-20260922'), 'claude-opus-5-5')
  assert.equal(baseModelId('claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(baseModelId('claude-future-20260922-preview'), 'claude-future-20260922-preview')
  assert.equal(baseModelId(null), '')
})
check('legacy Opus retains disabled thinking and 500 total output tokens', () => {
  for (const model of legacy.flatMap(id => [id, id + '-20260901'])) assert.deepEqual(replyModelParams(model), { model, max_tokens: 500, thinking: { type: 'disabled' } })
})
check('Opus 5.5, Fable and unknown models use adaptive low with a thinking allowance', () => {
  for (const model of adaptive.flatMap(id => [id, id + '-20260922'])) assert.deepEqual(replyModelParams(model), { model, max_tokens: 4096, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } })
})
check('probe and cache overrides preserve each model compatibility setting', () => {
  assert.equal(replyModelParams('claude-opus-5-5', { maxTokens: 1024 }).max_tokens, 1024)
  assert.equal(replyModelParams('claude-opus-5', { maxTokens: 64 }).max_tokens, 64)
  assert.equal(replyModelParams('claude-opus-5-5', { maxTokens: 64 }).thinking.type, 'adaptive')
  for (const maxTokens of [0, -1, 1.5, Infinity, '500']) assert.throws(() => replyModelParams('claude-opus-5', { maxTokens }))
  assert.throws(() => replyModelParams('unverified invalid model'))
})
check('text extraction ignores thinking, signatures and tool data', () => {
  assert.equal(responseText({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'PRIVATE', signature: 'PRIVATE' }, { type: 'redacted_thinking', data: 'PRIVATE' }, { type: 'text', text: 'Stock is available sir.' }, { type: 'tool_use', input: { text: 'PRIVATE' } }, { type: 'text', text: 'Here is the link.' }] }), 'Stock is available sir.\nHere is the link.')
})
check('legacy single text and leading empty thinking blocks work', () => {
  assert.equal(responseText({ stop_reason: 'end_turn', content: [{ type: 'text', text: ' Yes sir. ' }] }), 'Yes sir.')
  assert.equal(responseText({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Done sir.' }] }), 'Done sir.')
})
check('truncation, refusal and all non-final outcomes cannot become buyer text', () => {
  for (const stop_reason of ['max_tokens', 'refusal', 'tool_use', 'pause_turn', 'stop_sequence', 'model_context_window_exceeded', undefined, null, 'new-stop']) {
    assert.throws(() => responseText({ stop_reason, content: [{ type: 'text', text: 'Partial buyer text' }, { type: 'thinking', thinking: 'PRIVATE' }] }), error => error.code === 'REPLY_INCOMPLETE' && !error.message.includes('PRIVATE') && !error.message.includes('Partial'))
  }
})
check('empty or malformed response content fails without revealing thinking', () => {
  for (const content of [undefined, null, '', [], [{ type: 'thinking', thinking: 'PRIVATE' }], [{ type: 'text', text: ' \n ' }], [{ type: 'text', text: 123 }]]) assert.throws(() => responseText({ stop_reason: 'end_turn', content }), error => error.code === 'REPLY_EMPTY' && !error.message.includes('PRIVATE'))
  assert.throws(() => responseText(null), error => error.code === 'REPLY_INCOMPLETE')
})
check('known pricing includes the model-specific cache discounts', () => {
  for (const [model, input, output, read] of [['claude-opus-5-5', 4, 20, 0.2], ...legacy.map(model => [model, 5, 25, 0.5]), ['claude-fable-5-1', 10, 50, 0.25]]) {
    const pricing = modelPricing(model)
    assert.equal(pricing.inputPerMTok, input); assert.equal(pricing.outputPerMTok, output); assert.equal(pricing.cacheReadPerMTok, read)
    assert.equal(pricing.cacheWrite5mPerMTok, input * 1.25); assert.equal(pricing.cacheWrite1hPerMTok, input * 2)
    assert.equal(pricing.verified, true); assert.equal(pricing.estimated, false)
    assert.deepEqual(modelPricing(model + '-20260922'), pricing)
  }
})
check('unknown pricing is clearly estimated with the highest-known base rates', () => {
  const pricing = modelPricing('claude-future-9')
  assert.equal(pricing.inputPerMTok, 10); assert.equal(pricing.outputPerMTok, 50); assert.equal(pricing.cacheReadPerMTok, 1)
  assert.equal(pricing.cacheWrite5mPerMTok, 12.5); assert.equal(pricing.cacheWrite1hPerMTok, 20)
  assert.equal(pricing.verified, false); assert.equal(pricing.estimated, true)
  assert.equal(modelPricing('claude-opus-5-50').estimated, true)
})
check('fresh input, all output including hidden thinking, and cache reads are charged', () => {
  const cost = modelUsageCost('claude-opus-5-5', { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10000 })
  close(cost.costUsd, 0.004 + 0.04 + 0.002)
  assert.equal(cost.outputTokens, 2000); assert.equal(cost.estimated, false)
})
check('mixed detailed cache buckets override TTL without double counting aggregate writes', () => {
  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 10000, cache_creation_input_tokens: 5000, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 3000 } }
  const cost = modelUsageCost('claude-opus-5-5', usage)
  close(cost.costUsd, (1000 * 4 + 200 * 20 + 10000 * .2 + 2000 * 5 + 3000 * 8) / 1e6)
  assert.equal(cost.cacheWrite5mTokens, 2000); assert.equal(cost.cacheWrite1hTokens, 3000)
  assert.deepEqual(modelUsageCost('claude-opus-5-5', usage, { oneHour: true }), cost)
})
check('aggregate cache writes use requested TTL when detailed buckets are absent', () => {
  const usage = { cache_creation_input_tokens: 10000 }
  close(modelUsageCost('claude-opus-5-5', usage).costUsd, 0.05)
  close(modelUsageCost('claude-opus-5-5', usage, { oneHour: true }).costUsd, 0.08)
  close(modelUsageCost('claude-opus-5', usage).costUsd, 0.0625)
  close(modelUsageCost('claude-opus-5', usage, { oneHour: true }).costUsd, 0.1)
})
check('detailed buckets can supply writes without aggregate and infer a missing bucket', () => {
  close(modelUsageCost('claude-opus-5-5', { cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } }).costUsd, .021)
  const from5m = modelUsageCost('claude-opus-5-5', { cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000 } })
  const from1h = modelUsageCost('claude-opus-5-5', { cache_creation_input_tokens: 3000, cache_creation: { ephemeral_1h_input_tokens: 2000 } })
  assert.equal(from5m.cacheWrite1hTokens, 2000); assert.equal(from1h.cacheWrite5mTokens, 1000)
  close(from5m.costUsd, .021); close(from1h.costUsd, .021)
})
check('Fable and unknown accounting use their different read rates', () => {
  const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 } }
  const fable = modelUsageCost('claude-fable-5-1', usage), unknown = modelUsageCost('claude-future-9', usage)
  close(fable.costUsd, .01 + .05 + .00025 + .0125 + .02)
  close(unknown.costUsd, .01 + .05 + .001 + .0125 + .02)
  assert.equal(fable.estimated, false); assert.equal(unknown.estimated, true)
})
check('zero/absent usage remains zero and caller objects are unchanged', () => {
  assert.equal(modelUsageCost('claude-opus-5-5').costUsd, 0)
  const usage = Object.freeze({ input_tokens: 1, cache_creation_input_tokens: 0, cache_creation: Object.freeze({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }) })
  close(modelUsageCost('claude-opus-5-5', usage).costUsd, .000004)
  const pricing = modelPricing('claude-opus-5-5'); pricing.inputPerMTok = 999
  assert.equal(modelPricing('claude-opus-5-5').inputPerMTok, 4)
})
check('invalid and inconsistent usage cannot silently become a bogus zero cost', () => {
  for (const value of [-1, '100', NaN, Infinity, 1.5, null]) assert.throws(() => modelUsageCost('claude-opus-5-5', { input_tokens: value }))
  assert.throws(() => modelUsageCost('claude-opus-5-5', { cache_creation_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 2 } }))
  assert.throws(() => modelUsageCost('claude-opus-5-5', { cache_creation_input_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 } }))
})

console.log(`${checks} reply-model checks passed`)
