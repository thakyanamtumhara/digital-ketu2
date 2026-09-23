import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freezeReplayInputs, replayRequest, runReplayCase, privateDirectory, savePrivate, sha256, assertFreshReplayOutput } from './replay.mjs'
import { createReplayClient, replayUsageCost, compareMain } from './compare-reply-models.mjs'

const temp = mkdtempSync(join(tmpdir(), 'dk2-replay-tests-'))
const tests = []
const add = (name, fn) => tests.push([name, fn])
const packFor = (extra = {}) => freezeReplayInputs({ cases: [{ id: 'test', msg: 'Simple business question', must: ['Answer'], ...extra }], staticPrompt: 'Frozen rules', catalogBlock: 'Frozen catalogue', configuredModel: 'claude-opus-5-5', now: Date.parse('2026-09-23T00:00:00Z') })
const fixture = (model, overrides = {}) => ({ id: 'response-test', model, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'not buyer output' }, { type: 'text', text: 'Answer sir.' }], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 90, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 80 } }, ...overrides })
function transport(response, count = 200) {
  const calls = []
  return { calls, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body })
    assert.ok(url.startsWith('https://api.anthropic.com/v1/messages'))
    if (url.endsWith('/count_tokens')) return { ok: true, json: async () => ({ input_tokens: count }) }
    if (response instanceof Error) throw response
    return { ok: true, status: 200, headers: { get: () => 'request-test' }, json: async () => typeof response === 'function' ? response(body) : response }
  } }
}
add('frozen text/time/facts survive source mutation and model request mutation', () => {
  const cases = [{ id: 'test', msg: 'Original', stockSnapshot: { inStock: {} } }]
  const pack = freezeReplayInputs({ cases, staticPrompt: 'Rules', catalogProducts: [{ name: 'Original' }], configuredModel: 'claude-opus-5-5', now: 1234567890000 })
  cases[0].msg = 'Changed'; cases[0].stockSnapshot.inStock.changed = true
  const first = replayRequest(pack, pack.cases[0], 'claude-opus-5')
  const second = replayRequest(pack, pack.cases[0], 'claude-opus-5-5')
  assert.deepEqual(first.system, second.system); assert.deepEqual(first.messages, second.messages)
  assert.equal(first.max_tokens, 500); assert.equal(first.thinking.type, 'disabled')
  assert.equal(second.max_tokens, 4096); assert.deepEqual(second.output_config, { effort: 'low' })
  assert.equal(replayRequest(pack, pack.cases[0]).model, 'claude-opus-5-5')
  first.system[0].text = 'Changed'; assert.equal(pack.system[0].text, 'Rules')
  assert.match(second.messages[0].content, /Original/); assert.doesNotMatch(second.messages[0].content, /Changed/)
})
add('tampering with frozen request content is rejected', () => {
  const p = packFor(); p.cases[0].messages[0].content += 'changed'
  assert.throws(() => replayRequest(p, p.cases[0]), /Frozen replay inputs changed/)
})
add('inspected image bytes are frozen with both request and evidence hashes', () => {
  const file = join(temp, 'pixel.png')
  writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=', 'base64'))
  const p = packFor({ images: [{ path: file, reviewed: true, sourceId: 'synthetic-fixture' }] })
  const image = p.cases[0].messages[0].content[0]
  assert.equal(image.type, 'image'); assert.equal(p.cases[0].imageEvidence[0].reviewed, true)
  writeFileSync(file, 'changed')
  assert.equal(replayRequest(p, p.cases[0]).messages[0].content[0].source.data, image.source.data)
  assert.equal(p.cases[0].inputSha256, sha256({ system: p.system, messages: p.cases[0].messages }))
})
add('URL-only and uninspected media cannot claim vision coverage', () => {
  assert.throws(() => packFor({ imageUrl: 'https://example.invalid/a.jpg' }), /imageUrl alone/)
  assert.throws(() => packFor({ images: [{ path: 'not-read', reviewed: false }] }), /inspect image/)
})
add('actual model/request identity, cache buckets, raw visible text and guarded reply are separate', async () => {
  const mock = transport(body => fixture(body.model + '-20260923'))
  const client = createReplayClient({ apiKey: 'test-only', budgetInr: 50, fetchImpl: mock.fetchImpl })
  const p = packFor(), r = await runReplayCase(p, p.cases[0], 'claude-opus-5-5', client)
  assert.equal(r.ok, true); assert.equal(r.rawText, 'Answer sir.'); assert.equal(r.finalText, 'Answer sir.')
  assert.equal(r.calls[0].returnedModel, 'claude-opus-5-5-20260923')
  assert.equal(r.calls[0].requestId, 'request-test'); assert.equal(r.calls[0].responseId, 'response-test')
  assert.equal(r.calls[0].cost.cacheWrite5mTokens, 20); assert.equal(r.calls[0].cost.cacheWrite1hTokens, 80)
  assert.equal(r.calls[0].costUsd, 0.001198); assert.equal(client.reservedUsd, 0)
  assert.equal(mock.calls.filter(c => !c.url.endsWith('/count_tokens')).length, 1)
})
add('incomplete output is charged and rejected without retry or guards', async () => {
  const mock = transport(fixture('claude-opus-5-5', { stop_reason: 'max_tokens' }))
  const client = createReplayClient({ apiKey: 'test-only', budgetInr: 50, fetchImpl: mock.fetchImpl })
  const p = packFor(), r = await runReplayCase(p, p.cases[0], 'claude-opus-5-5', client)
  assert.equal(r.incomplete, true); assert.equal(r.ok, false); assert.equal(r.guardedText, null)
  assert.ok(client.spentUsd > 0); assert.equal(client.records.length, 1)
})
add('conservative budget stops before paid request', async () => {
  const mock = transport(fixture('claude-opus-5'), 100000)
  const client = createReplayClient({ apiKey: 'test-only', budgetInr: 1, fetchImpl: mock.fetchImpl })
  const p = packFor()
  await assert.rejects(client.messages.create(replayRequest(p, p.cases[0], 'claude-opus-5')), { code: 'REPLAY_BUDGET_STOP' })
  assert.equal(mock.calls.length, 1); assert.equal(client.records.length, 0)
})
add('failed request retains uncertain budget reserve and prevents automatic retry', async () => {
  const mock = transport(Object.assign(Error('network'), { code: 'ECONNRESET' }))
  const client = createReplayClient({ apiKey: 'test-only', budgetInr: 50, fetchImpl: mock.fetchImpl })
  const p = packFor(), request = replayRequest(p, p.cases[0])
  await assert.rejects(client.messages.create(request), { code: 'ECONNRESET' })
  assert.ok(client.reservedUsd > 0); assert.equal(client.spentUsd, 0)
  await assert.rejects(client.messages.create(request), { code: 'REPLAY_HALTED' })
  assert.equal(mock.calls.length, 2)
})
add('Haiku rewrite identity and spend are recorded separately', async () => {
  const mock = transport(body => fixture(body.model, { content: [{ type: 'text', text: body.model.includes('haiku') ? 'Available sir.' : 'Available hai sir.' }], usage: { input_tokens: 100, output_tokens: 10 } }))
  const client = createReplayClient({ apiKey: 'test-only', budgetInr: 50, fetchImpl: mock.fetchImpl })
  const p = packFor({ msg: 'Please share product availability', must: ['Available'] })
  const r = await runReplayCase(p, p.cases[0], 'claude-opus-5', client)
  assert.equal(r.calls.length, 2); assert.equal(r.calls[1].returnedModel, 'claude-haiku-4-5-20251001')
  assert.ok(Math.abs(r.calls[1].costUsd - 0.00015) < 1e-12); assert.equal(r.rawText, 'Available hai sir.'); assert.equal(r.finalText, 'Available sir.')
})
add('explicit cache accounting for Haiku retains its own rates', () => {
  const c = replayUsageCost('claude-haiku-4-5-20251001', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 }, true)
  assert.ok(Math.abs(c.costUsd - 0.00032) < 1e-12); assert.equal(c.rates.inputPerMTok, 1)
})
add('raw output cannot be saved inside a git repository', () => {
  const repository = join(temp, 'repository')
  mkdirSync(join(repository, '.git'), { recursive: true })
  assert.throws(() => privateDirectory(join(repository, 'nested', 'output')), /outside every git repository/)
  const worktree = join(temp, 'worktree')
  mkdirSync(worktree)
  writeFileSync(join(worktree, '.git'), 'gitdir: ../repository/.git/worktrees/fixture\n')
  assert.throws(() => privateDirectory(join(worktree, 'nested', 'output')), /outside every git repository/)
  const path = join(temp, 'safe', 'result.json'); savePrivate(path, { ok: true }); assert.equal(JSON.parse(readFileSync(path)).ok, true)
})
add('a reused output cannot silently reset prior paid or uncertain spend', () => {
  const out = privateDirectory(join(temp, 'used'))
  assertFreshReplayOutput(out)
  savePrivate(join(out, 'calls.json'), [{ status: 'uncertain' }])
  assert.throws(() => assertFreshReplayOutput(out), /already contains/)
})
add('wrong known model and missing model retain usage but stop the comparison', async () => {
  for (const model of ['claude-opus-5', undefined]) {
    const mock = transport(fixture(model))
    const client = createReplayClient({ apiKey: 'test-only', budgetInr: 50, fetchImpl: mock.fetchImpl })
    const p = packFor()
    await assert.rejects(client.messages.create(replayRequest(p, p.cases[0], 'claude-opus-5-5')), { code: 'REPLAY_MODEL_MISMATCH' })
    assert.ok(client.spentUsd > 0); assert.equal(client.halted, true); assert.equal(client.records[0].returnedIdentityVerified, false)
    assert.equal(client.records[0].status, 'rejected'); assert.equal(client.records[0].usage.output_tokens, 20)
  }
})
add('an explicitly dated model must return that exact snapshot', async () => {
  const mock = transport(fixture('claude-opus-5-5-20260922'))
  const client = createReplayClient({ apiKey: 'test-only', budgetInr: 50, fetchImpl: mock.fetchImpl })
  const p = packFor()
  await assert.rejects(client.messages.create(replayRequest(p, p.cases[0], 'claude-opus-5-5-20260923')), { code: 'REPLAY_MODEL_MISMATCH' })
})
add('nonfinite budgets/rates and invalid output limits cannot bypass preflight', async () => {
  for (const value of [Infinity, NaN, -1, 0]) {
    assert.throws(() => createReplayClient({ apiKey: 'test', budgetInr: value }), /finite positive/)
    assert.throws(() => createReplayClient({ apiKey: 'test', budgetInr: 50, exchangeRate: value }), /finite positive/)
  }
  const mock = transport(fixture('claude-opus-5'))
  const client = createReplayClient({ apiKey: 'test-only', budgetInr: 50, fetchImpl: mock.fetchImpl })
  for (const value of [Infinity, NaN, 0, -1, 1.5]) await assert.rejects(client.messages.create({ model: 'claude-opus-5', max_tokens: value }), /finite positive/)
  assert.equal(mock.calls.length, 0)
})
add('rerun rejection preserves the original frozen evidence before loading new inputs', async () => {
  const out = privateDirectory(join(temp, 'preserve'))
  savePrivate(join(out, 'calls.json'), [{ status: 'received', costUsd: 0.1 }])
  savePrivate(join(out, 'frozen-inputs.json'), { original: true })
  await assert.rejects(compareMain(['--output', out, '--frozen', join(temp, 'does-not-exist.json')]), /already contains/)
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'frozen-inputs.json'), 'utf8')), { original: true })
})
try {
  for (const [name, fn] of tests) { await fn(); console.log('PASS ' + name) }
  console.log(`${tests.length}/${tests.length} replay/model checks passed; no real network calls`)
} finally { rmSync(temp, { recursive: true, force: true }) }
