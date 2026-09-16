import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'
import { createHash } from 'node:crypto'

async function review({ buyerMessage, ketuReply }) {
  const candidates = new Map(), writes = [], requests = [], updates = []
  let embeddings = 0
  const pair = { id: 'synthetic-pair', whatsappNumber: 'synthetic-buyer', createdAt: new Date('2026-01-01'), buyerMessage, ketuReply }
  const context = createContext({ console: { log() {}, error() {} }, process: { env: {} }, Date })
  class Provider {
    messages = { create: async request => {
      requests.push(request)
      return { content: [{ text: request.max_tokens === 5 ? 'YES' : JSON.stringify([{ id: pair.id, aiWouldFail: true, contextDependent: false, category: 'pricing' }]) }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }
    } }
  }
  const stubs = {
    '@anthropic-ai/sdk': { default: Provider },
    './process.js': { chargeSpend() {}, clearFilterCache() {} },
    './embeddings.js': { getEmbedding: async () => { embeddings++; return '[0]'} },
    'node:crypto': { createHash },
  }
  const modules = new Map()
  async function link(specifier, parent) {
    const url = stubs[specifier] ? specifier : new URL(specifier, parent.identifier).href
    if (modules.has(url)) return modules.get(url)
    const stub = stubs[specifier]
    const module = stub
      ? new SyntheticModule(Object.keys(stub), function () { for (const [name, value] of Object.entries(stub)) this.setExport(name, value) }, { context, identifier: url })
      : new SourceTextModule(await readFile(new URL(url), 'utf8'), { context, identifier: url })
    modules.set(url, module)
    await module.link(link)
    return module
  }
  const url = new URL('../server/reviewer.js', import.meta.url)
  const module = new SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href })
  await module.link(link)
  await module.evaluate()
  const db = {
    manualReplyPair: { findMany: async () => [pair], update: async ({ data }) => { updates.push(data) } },
    knowledgeChunk: { findFirst: async () => null },
    $executeRawUnsafe: async () => 0,
    $executeRaw: async (strings, ...values) => {
      const sql = strings.join('?')
      if (sql.includes('INSERT INTO "LearningCandidate"')) {
        const [id, origin, payload] = values
        candidates.set(id, { id, origin, payload: JSON.parse(payload), status: 'pending' })
      } else if (sql.includes("status = 'promoted'")) candidates.get(values[0]).status = 'promoted'
      else if (sql.includes('UPDATE "LearningCandidate"')) {
        const [status, reason, id] = values
        Object.assign(candidates.get(id), { status, reason })
      } else if (sql.includes('INSERT INTO "KnowledgeChunk"')) writes.push('knowledge')
      else if (sql.includes('INSERT INTO "DeferToKetu"')) writes.push('defer')
      else assert.fail('unexpected mutation')
      return 1
    },
    $queryRaw: async (_strings, id) => candidates.has(id) ? [candidates.get(id)] : [],
  }
  const result = await module.namespace.reviewManualPairs(db, { model: 'claude-opus-5', batchSize: 1 })
  return { result, candidates: [...candidates.values()], writes, requests, updates, embeddings }
}

const originalShape = await review({ buyerMessage: 'These tshirt rates increased a lot', ketuReply: 'The increase was only 9 rupees, supplier prices went up.' })
assert.equal(originalShape.result.corrections, 0)
assert.equal(originalShape.requests.length, 1)
assert.equal(originalShape.embeddings, 0)
assert.deepEqual(originalShape.writes, [])
assert.equal(originalShape.candidates[0].status, 'rejected')
assert.equal(originalShape.candidates[0].reason, 'perishable_price_answer')
assert.equal(originalShape.updates[0].reviewResult, 'skipped')

const neighbour = await review({ buyerMessage: 'Where should I check updated rates?', ketuReply: 'Please check the current website catalogue for rates.' })
assert.equal(neighbour.result.corrections, 1)
assert.equal(neighbour.requests.length, 2)
assert.equal(neighbour.embeddings, 1)
assert.deepEqual(neighbour.writes, ['defer', 'knowledge'])
assert.equal(neighbour.candidates[0].status, 'promoted')
assert.equal(neighbour.updates[0].reviewResult, 'correction_added')
const trackingAction = await review({ buyerMessage: 'Please check my parcel details.', ketuReply: 'नंबर ठीक कर दिया, ट्रैकिंग अभी भेजता हूँ।' })
assert.equal(trackingAction.result.corrections, 0)
assert.equal(trackingAction.requests.length, 1)
assert.equal(trackingAction.embeddings, 0)
assert.deepEqual(trackingAction.writes, [])
assert.equal(trackingAction.candidates[0].status, 'rejected')
assert.equal(trackingAction.candidates[0].reason, 'transactional_reply')
assert.equal(trackingAction.updates[0].reviewResult, 'skipped')
console.log('21 reviewer learning integration assertions passed')
