import assert from 'node:assert/strict'

const originalFetch = globalThis.fetch
const originalKey = process.env.VOYAGE_API_KEY
process.env.VOYAGE_API_KEY = 'embedding-test-only'
const { vectorSearch } = await import('../server/embeddings.js?embedding-reuse-configured')
delete process.env.VOYAGE_API_KEY
const withoutProvider = await import('../server/embeddings.js?embedding-reuse-unconfigured')
if (originalKey === undefined) delete process.env.VOYAGE_API_KEY
else process.env.VOYAGE_API_KEY = originalKey

const query = 'synthetic regular-fit colour question'
const knowledgeOptions = { limit: 10, minSimilarity: 0, excludeSources: ['STYLE_GUIDE', 'STYLE_PAIR', 'PREMIUM_PAIR', 'CATALOG'] }
const styleOptions = { limit: 3, minSimilarity: 0.3, sources: ['STYLE_PAIR', 'PREMIUM_PAIR'] }
const records = [
  { id: 'catalog', source: 'CATALOG', similarity: 0.99 },
  { id: 'guide', source: 'STYLE_GUIDE', similarity: 0.95 },
  { id: 'correction', source: 'CORRECTION', similarity: 0.93 },
  { id: 'style', source: 'STYLE_PAIR', similarity: 0.83 },
  { id: 'policy', source: 'POLICY', similarity: 0.71 },
  { id: 'premium', source: 'PREMIUM_PAIR', similarity: 0.55 },
  { id: 'weak-style', source: 'STYLE_PAIR', similarity: 0.2 },
]
let requests = []
let checks = 0
function installFetch(responder = async () => ({ ok: true, json: async () => ({ data: [{ embedding: [0.125, -0.25, 0.5] }] }) })) {
  requests = []
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.voyageai.com/v1/embeddings')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer embedding-test-only')
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'voyage-3')
    assert.equal(body.input_type, 'query')
    assert.equal(body.input.length, 1)
    requests.push(body)
    return responder(requests.length, body)
  }
}
function database() {
  const calls = []
  return {
    calls,
    async $queryRaw(strings, ...values) {
      calls.push({ sql: strings.join('?'), values })
      const sql = strings.join('?')
      let rows = records
      if (sql.includes('source::text = ANY')) rows = rows.filter(row => values[1].includes(row.source))
      if (sql.includes('source::text != ALL')) rows = rows.filter(row => !values[1].includes(row.source))
      return rows.slice(0, values.at(-1))
    },
  }
}
async function searches(search, db, embeddingCache) {
  return [
    await search(db, null, query, { ...knowledgeOptions, embeddingCache }),
    await search(db, null, query, { ...styleOptions, embeddingCache }),
  ]
}
async function check(name, fn) {
  await fn()
  checks++
  console.log('PASS ' + name)
}

try {
  await check('two actual searches reuse one provider response without changing SQL or results', async () => {
    installFetch()
    const baselineDb = database()
    const baseline = await searches(vectorSearch, baselineDb)
    assert.equal(requests.length, 2)
    assert.deepEqual(baseline.map(rows => rows.map(row => row.id)), [['correction', 'policy'], ['style', 'premium']])
    installFetch()
    const reusedDb = database()
    assert.deepEqual(await searches(vectorSearch, reusedDb, new Map()), baseline)
    assert.equal(requests.length, 1)
    assert.deepEqual(reusedDb.calls, baselineDb.calls)
    assert.equal(reusedDb.calls[0].values[0], '[0.125,-0.25,0.5]')
  })

  await check('separate reply requests cannot share a query embedding', async () => {
    installFetch()
    await searches(vectorSearch, database(), new Map())
    await searches(vectorSearch, database(), new Map())
    assert.equal(requests.length, 2)
  })

  await check('different query text cannot reuse the previous vector', async () => {
    installFetch(async (_count, body) => ({ ok: true, json: async () => ({ data: [{ embedding: body.input[0] === query ? [1, 0] : [0, 1] }] }) }))
    const db = database(), embeddingCache = new Map()
    await vectorSearch(db, null, query, { ...knowledgeOptions, embeddingCache })
    await vectorSearch(db, null, query + ' changed', { ...styleOptions, embeddingCache })
    assert.equal(requests.length, 2)
    assert.equal(db.calls[0].values[0], '[1,0]')
    assert.equal(db.calls[1].values[0], '[0,1]')
  })

  await check('concurrent searches in one request share only the embedding work', async () => {
    installFetch()
    const db = database(), embeddingCache = new Map()
    const output = await Promise.all([
      vectorSearch(db, null, query, { ...knowledgeOptions, embeddingCache }),
      vectorSearch(db, null, query, { ...styleOptions, embeddingCache }),
    ])
    assert.equal(requests.length, 1)
    assert.equal(db.calls.length, 2)
    assert.deepEqual(output.map(rows => rows.map(row => row.id)), [['correction', 'policy'], ['style', 'premium']])
  })

  await check('network failure still propagates and the next search retries', async () => {
    const failure = new Error('synthetic connection failure')
    installFetch(async count => {
      if (count === 1) throw failure
      return { ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) }
    })
    const db = database(), embeddingCache = new Map()
    await assert.rejects(vectorSearch(db, null, query, { embeddingCache }), error => error === failure)
    assert.equal(embeddingCache.size, 0)
    assert.equal(db.calls.length, 0)
    await vectorSearch(db, null, query, { embeddingCache })
    assert.equal(requests.length, 2)
  })

  await check('invalid JSON still propagates and is not cached', async () => {
    const failure = new SyntaxError('synthetic bad JSON')
    installFetch(async count => ({ ok: true, json: async () => {
      if (count === 1) throw failure
      return { data: [{ embedding: [1, 0] }] }
    } }))
    const db = database(), embeddingCache = new Map()
    await assert.rejects(vectorSearch(db, null, query, { embeddingCache }), error => error === failure)
    assert.equal(embeddingCache.size, 0)
    await vectorSearch(db, null, query, { embeddingCache })
    assert.equal(requests.length, 2)
  })

  await check('HTTP error keeps the old hash fallback and retries Voyage on the next search', async () => {
    const responder = async count => count === 1
      ? { ok: false, status: 429, text: async () => 'synthetic retry later' }
      : { ok: true, json: async () => ({ data: [{ embedding: [0.125, -0.25, 0.5] }] }) }
    installFetch(responder)
    const baselineDb = database(), baseline = await searches(vectorSearch, baselineDb)
    assert.equal(requests.length, 2)
    installFetch(responder)
    const reusedDb = database()
    assert.deepEqual(await searches(vectorSearch, reusedDb, new Map()), baseline)
    assert.equal(requests.length, 2)
    assert.deepEqual(reusedDb.calls, baselineDb.calls)
    assert.equal(JSON.parse(reusedDb.calls[0].values[0]).length, 1024)
    assert.equal(reusedDb.calls[1].values[0], '[0.125,-0.25,0.5]')
  })

  await check('missing provider configuration preserves the existing hash-only search', async () => {
    installFetch(async () => { throw Error('hash-only mode must not call HTTP') })
    const baselineDb = database(), baseline = await searches(withoutProvider.vectorSearch, baselineDb)
    const reusedDb = database()
    assert.deepEqual(await searches(withoutProvider.vectorSearch, reusedDb, new Map()), baseline)
    assert.equal(requests.length, 0)
    assert.deepEqual(reusedDb.calls, baselineDb.calls)
    assert.equal(JSON.parse(reusedDb.calls[0].values[0]).length, 1024)
  })

  await check('SQL errors are still surfaced to the caller', async () => {
    installFetch()
    const failure = new Error('synthetic SQL failure')
    const db = { async $queryRaw() { throw failure } }
    await assert.rejects(vectorSearch(db, null, query, { embeddingCache: new Map() }), error => error === failure)
    assert.equal(requests.length, 1)
  })
} finally {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.VOYAGE_API_KEY
  else process.env.VOYAGE_API_KEY = originalKey
}

console.log(checks + ' embedding reuse checks passed')
