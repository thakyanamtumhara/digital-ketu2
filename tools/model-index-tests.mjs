import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createModelControl, assessModelOutput } from '../server/model-control.js'
import { REPLY_MODEL_INFO, resolveReplyModel, baseModelId, validReplyModelId, replyModelParams, modelUsageCost } from '../server/reply-models.js'

const source = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
function block(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `Missing source block ${start}`)
  return source.slice(a, b)
}
const code = [
  block('let opus5GuardBusy', "app.post('/api/fidelity/send-digest'"),
  block('let lastPrewarmKey', '// COST-CEILING ALARM'),
  block('const modelControl = createModelControl(', '// DEFER SCOREBOARD'),
  block("app.put('/api/settings'", '// ==========================================='),
  block("app.get('/api/ai-status'", '// Which database'),
].join('\n') + '\nglobalThis.testExports = { opus5Guard, cacheKeepAlive, forceCacheRewarm };'
const at = Date.parse('2026-09-23T06:00:00Z')
const usage = { input_tokens: 12, output_tokens: 64, cache_read_input_tokens: 100, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } }
const row = (model, words = 20, extra = {}) => ({ status: 'REPLIED', costUsd: .01, sentViaWwbun: true, aiReply: Array(words).fill('word').join(' '), modelUse: { responseModel: model, outputSource: 'model' }, completionTokens: 9000, ...extra })
function fixture({ model = 'claude-opus-5-5', cachedModel = model } = {}) {
  const data = { settings: { replyModel: model, replyModelSetAt: new Date(at - 60000), systemPrompt: 'PRIVATE_PROMPT', dailySpentUsd: 0, dailyJobSpentUsd: 0 }, cached: { replyModel: cachedModel, systemPrompt: 'PRIVATE_PROMPT' }, queries: [], rows: [], recent: [], requests: [], updates: [], cas: [], notifications: [], errors: [], modelLists: 0 }
  const handlers = new Map()
  const db = {
    async $queryRaw(strings, ...values) { data.queries.push({ sql: strings.join('?'), values }); return data.rows },
    async $queryRawUnsafe(sql) { data.queries.push({ sql }); return [] },
    settings: {
      async findUnique() { return { ...data.settings } },
      async update({ data: updates }) {
        data.updates.push(updates)
        for (const [key, value] of Object.entries(updates)) data.settings[key] = value?.increment === undefined ? value : (data.settings[key] || 0) + value.increment
        return { ...data.settings }
      },
      async updateMany(query) {
        data.cas.push(query)
        data.beforeCas?.()
        if (query.where.replyModel !== data.settings.replyModel || +query.where.replyModelSetAt !== +data.settings.replyModelSetAt) return { count: 0 }
        Object.assign(data.settings, query.data); return { count: 1 }
      },
    },
    knowledgeChunk: { async findFirst() { return { content: 'PRIVATE_STYLE' } } },
    messageLog: { async findMany() { return data.recent } },
  }
  const anthropic = {
    models: { list() { data.modelLists++; return { async *[Symbol.asyncIterator]() { yield { id: 'claude-opus-5-5' }; yield { id: 'claude-opus-5' } } } } },
    messages: { async create(params, options) {
      data.requests.push({ params, options })
      if (data.probe) return data.probe(params)
      return { model: params.model, stop_reason: params.messages[0].content === 'ping' ? 'max_tokens' : 'end_turn', usage, content: [{ type: 'text', text: 'READY' }] }
    } },
  }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [at])) } static now() { return at } }
  const context = {
    db, anthropic, createModelControl, assessModelOutput, REPLY_MODEL_INFO, resolveReplyModel, baseModelId, validReplyModelId, replyModelParams, modelUsageCost,
    Date: Clock, console: { log() {}, error(...args) { data.errors.push(args.join(' ')) } },
    app: Object.fromEntries(['get', 'post', 'put'].map(method => [method, (path, handler) => handlers.set(method + path, handler)])),
    getSettings: async () => data.cached, cachedSettings: data.cached, settingsCacheExpiry: at + 60000,
    cacheTouch: { at: 0, model: null }, fallbackState: { at: 0, model: null }, DEFAULT_SYSTEM_PROMPT: 'PRIVATE_DEFAULT',
    notifyOwner: async message => data.notifications.push(message), setInterval() {}, setTimeout() {},
    costAlarm: { avgInr: 2, ceiling: 5, over: false, replies: 12 }, COST_ALARM_USD_TO_INR: 88,
    probeAnthropic: async () => ({ ok: true }),
  }
  runInNewContext(code, context)
  async function request(method, path, body = {}, query = {}) {
    const headers = {}
    const c = { req: { json: async () => body, query: key => query[key] }, header: (key, value) => { headers[key] = value }, json: (body, status = 200) => ({ body, status, headers }) }
    return handlers.get(method + path)(c)
  }
  return { data, context, request, ...context.testExports }
}
let checks = 0
async function check(name, action) { await action(); checks++; console.log('PASS ' + name) }

await check('guard uses actual model, visible words and bounded selected-outcome SQL', async () => {
  const f = fixture()
  f.data.rows = [...Array.from({ length: 12 }, () => row('claude-opus-5-5')), ...Array.from({ length: 20 }, () => row('claude-opus-5', 150))]
  await f.opus5Guard()
  assert.equal(f.data.cas.length, 0)
  const q = f.data.queries[0]
  assert.match(q.sql, /LIMIT 200/); assert.match(q.sql, /outputSource.*IS DISTINCT FROM 'rule'/)
  assert.match(q.sql, /regexp_replace/); assert.ok(q.values.includes('claude-opus-5-5'))
  assert.equal(q.sql.includes('completionTokens'), false)
})
await check('guard performs CAS rollback and clears model-scoped cache only on success', async () => {
  const f = fixture(); f.data.rows = Array.from({ length: 8 }, () => row('claude-opus-5-5', 75))
  f.context.cacheTouch = { at, model: 'claude-opus-5-5' }
  await f.opus5Guard()
  assert.equal(f.data.settings.replyModel, 'claude-opus-5'); assert.equal(f.data.cas.length, 1)
  assert.equal(f.context.cacheTouch.at, 0); assert.equal(f.context.cacheTouch.model, null)
  assert.equal(f.data.notifications.length, 1); assert.match(f.data.notifications[0], /Opus 5:/)
  assert.equal(f.data.notifications[0].includes('PRIVATE'), false)
})
await check('guard cannot overwrite a newer manual switch or notify a failed rollback', async () => {
  const f = fixture(); f.data.rows = Array.from({ length: 8 }, () => row('claude-opus-5-5', 75))
  f.data.beforeCas = () => { f.data.settings.replyModel = 'claude-future-6'; f.data.settings.replyModelSetAt = new Date(at) }
  await f.opus5Guard()
  assert.equal(f.data.settings.replyModel, 'claude-future-6'); assert.equal(f.data.notifications.length, 0)
})
await check('cache warmer uses current DB model despite stale cached settings and prices all usage buckets', async () => {
  const f = fixture({ cachedModel: 'claude-opus-5' })
  await f.cacheKeepAlive()
  const { params, options } = f.data.requests[0]
  assert.equal(params.model, 'claude-opus-5-5'); assert.equal(params.thinking.type, 'adaptive'); assert.equal(params.output_config.effort, 'low')
  assert.equal(params.max_tokens, 64); assert.equal(params.system[0].cache_control.ttl, '1h'); assert.equal(options.maxRetries, 0)
  assert.equal(f.data.updates[0].dailySpentUsd.increment, modelUsageCost(params.model, usage, { oneHour: true }).costUsd)
  assert.equal(f.context.cacheTouch.model, 'claude-opus-5-5'); assert.equal(f.context.cacheTouch.at, at)
})
await check('another model cache cannot suppress selected prewarm and legacy compatibility is preserved', async () => {
  const f = fixture({ model: 'claude-opus-5' }); f.context.cacheTouch = { at: at - 30000, model: 'claude-opus-5-5' }
  await f.cacheKeepAlive()
  assert.equal(f.data.requests[0].params.model, 'claude-opus-5'); assert.equal(f.data.requests[0].params.thinking.type, 'disabled')
  assert.equal(f.data.requests[0].params.output_config, undefined)
})
await check('fresh selected cache skips paid ping, including canonical model dated response', async () => {
  const f = fixture(); f.context.cacheTouch = { at: at - 30000, model: 'claude-opus-5-5-20260922' }
  await f.cacheKeepAlive(); assert.equal(f.data.requests.length, 0)
})
await check('wrong or missing response model is billed but never stamps a verified warm cache', async () => {
  for (const model of ['claude-opus-5', undefined]) {
    const f = fixture(); f.data.probe = () => ({ model, usage })
    await f.cacheKeepAlive()
    assert.equal(f.data.updates.length, 1); assert.equal(f.context.cacheTouch.at, 0); assert.equal(f.context.cacheTouch.model, null)
  }
})
await check('old in-flight cache ping cannot overwrite the new selected model cache', async () => {
  const f = fixture()
  f.data.probe = params => {
    f.data.settings.replyModel = 'claude-opus-5'
    f.context.cacheTouch = { at, model: 'claude-opus-5' }
    return { model: params.model, usage }
  }
  await f.cacheKeepAlive(); assert.equal(f.context.cacheTouch.model, 'claude-opus-5')
  assert.equal(f.data.updates.length, 1)
})
await check('cache warmup failure is not automatically retried and cannot parallelize paid pings', async () => {
  const f = fixture(); let release
  f.data.probe = () => new Promise((resolve, reject) => { release = () => reject(Error('mock failure')) })
  const first = f.cacheKeepAlive()
  for (let n = 0; n < 10 && !release; n++) await Promise.resolve()
  assert.ok(release); await f.cacheKeepAlive(); assert.equal(f.data.requests.length, 1)
  release(); await first; await f.cacheKeepAlive(); assert.equal(f.data.requests.length, 1)
})
await check('generic settings preserves ordinary saves and unchanged roundtrip fields without writing model fields', async () => {
  const f = fixture()
  let result = await f.request('put', '/api/settings', { isActive: true })
  assert.equal(result.status, 200)
  result = await f.request('put', '/api/settings', { replyModel: f.data.settings.replyModel, replyModelSetAt: f.data.settings.replyModelSetAt.toISOString(), isActive: false })
  assert.equal(result.status, 200); assert.equal(f.data.updates.at(-1).isActive, false)
  assert.equal(Object.hasOwn(f.data.updates.at(-1), 'replyModel'), false); assert.equal(Object.hasOwn(f.data.updates.at(-1), 'replyModelSetAt'), false)
})
await check('generic settings cannot bypass the verified switch or rewrite its timestamp', async () => {
  const f = fixture()
  for (const body of [{ replyModel: 'claude-future-6' }, { replyModelSetAt: null }, { replyModelSetAt: 'invalid' }]) assert.equal((await f.request('put', '/api/settings', body)).status, 400)
  assert.equal(f.data.updates.length, 0); assert.equal(f.data.requests.length, 0)
})
await check('model routes honor explicit refresh, no-store status and verified switching with job charge', async () => {
  const f = fixture({ model: 'claude-opus-5' })
  assert.equal((await f.request('get', '/api/model')).headers['Cache-Control'], 'no-store')
  await f.request('get', '/api/model'); assert.equal(f.data.modelLists, 1)
  await f.request('get', '/api/model', {}, { refresh: '1' }); assert.equal(f.data.modelLists, 2)
  const result = await f.request('post', '/api/model', { model: 'claude-opus-5-5' })
  assert.equal(result.status, 200); assert.equal(result.body.verifiedModel, 'claude-opus-5-5')
  assert.equal(f.data.settings.replyModel, 'claude-opus-5-5'); assert.ok(f.data.updates[0].dailyJobSpentUsd.increment > 0)
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(f.context.settingsCacheExpiry, 0)
})
await check('model route failures expose no provider or database details and do not activate', async () => {
  const f = fixture({ model: 'claude-opus-5' }); f.data.probe = () => { throw Error('PRIVATE_PROMPT') }
  const result = await f.request('post', '/api/model', { model: 'claude-opus-5-5' })
  assert.equal(result.status, 502); assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
  assert.equal(f.data.settings.replyModel, 'claude-opus-5')
})
await check('status names Claude fallback honestly while retaining legacy OpenAI naming', async () => {
  const f = fixture(); f.context.fallbackState = { at: at - 1000, model: 'claude-opus-5' }
  let result = await f.request('get', '/api/ai-status')
  assert.equal(result.body.brain, 'claude-opus-5'); assert.equal(result.body.detail, 'claude_fallback_active')
  assert.match(result.body.reason, /recent reply attempt.*Claude backup/)
  assert.doesNotMatch(result.body.reason, /OpenAI|credits|ARE getting replies/)
  f.context.fallbackState.model = 'gpt-4o-mini'
  result = await f.request('get', '/api/ai-status'); assert.match(result.body.reason, /OpenAI backup/)
})
await check('model switch stays protected by the existing admin write middleware', () => {
  const middleware = block("const writeGuard =", '// --- Health Check ---')
  assert.match(middleware, /X-DK-Admin-Token/); assert.match(middleware, /'\/api\/model'/)
  assert.match(middleware, /app\.use\(p, writeGuard\)/)
})
console.log(`${checks} model index integration checks passed`)
