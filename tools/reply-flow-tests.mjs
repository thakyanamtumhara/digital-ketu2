import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm'

const processUrl = new URL('../server/process.js', import.meta.url)
const source = await readFile(processUrl, 'utf8')

async function runCase({ reply = 'Address sir: Khanpur.', failCalls = 0, guardThrows = false, cooldown = false, history = [], timedFacts = [], incomingText = null, catalogUnavailable = false, knowledge = [] } = {}) {
  const sent = [], logs = [], errors = [], requests = []
  let calls = 0, conversationReads = 0
  const context = createContext({
    console: { log() {}, warn() {}, error(...args) { errors.push(args.join(' ')) } },
    process: { env: { WWBUN_API_URL: 'https://transport.invalid', DIGITAL_KETU_SECRET: 'test-only', OWNER_WHATSAPP: 'owner-test' } },
    Buffer, URL, Date, AbortController, AbortSignal,
    setTimeout(fn, ms) { if (ms < 30000) queueMicrotask(fn); return { unref() {} } },
    clearTimeout() {},
    fetch: async (url, options) => {
      if (String(url).startsWith('https://www.bulkplaintshirt.com/catalog/products.json?')) {
        if (catalogUnavailable) throw Error('catalog unavailable')
        return { ok: true, json: async () => ({ categories: [{ products: [{
          name: 'Example Hoodie', slug: 'hoodie-320gsm', gsm: 320,
          colors: ['Black', 'White'], sizes: ['M', 'XXL'],
          rates: [
            { colors: ['Black'], pricePerSize: { M: 211, XXL: 223 }, samplePrice: 277 },
            { colors: ['White'], pricePerSize: { M: 239, XXL: 251 }, samplePrice: 299 },
          ],
        }] }] }) }
      }
      if (String(url).startsWith('https://www.bulkplaintshirt.com/pc.js?')) return { ok: true, text: async () => 'let tbl=[{"Sale: Example":{"Green":{"22":63}}},{"Sale: Example":["Example","Sale product"]},{"Sale: Example":91}]' }
      assert.equal(String(url), 'https://transport.invalid/api/messages/send-ai-reply' , 'unexpected network request')
      sent.push(JSON.parse(options.body))
      return { ok: true, json: async () => ({ messageId: 'sent-test' }) }
    },
  })
  const stubs = {
    './embeddings.js': { vectorSearch: async (_db, _ai, _text, opts) => opts.sources?.includes('STYLE_PAIR') ? [] : knowledge },
    './transcribe.js': { transcribeAudio() {}, isTranscriptionConfigured: () => false, getTranscriptionProvider() {} },
    './ig-gate.js': { evaluateIgGate() {} },
    './order-lookup.js': { lookupOrdersByPhone: async () => [], formatOrderLookupBlock: () => '', getBuyerProfile: async () => null, formatBuyerProfileBlock: () => '' },
    './stock-lookup.js': { getStockSnapshot: async () => ({}), formatStockBlock: () => '', resolveUnnamedProduct: () => '', unnamedProductCandidates: () => [], unnamedProductGuard() {} },
    './photo-links.js': { getPhotoIndex: async () => [], formatPhotoBlock: () => '', PHOTO_INTENT_RE: /a^/ },
    './openai-fallback.js': { openaiReply() { throw Error('unexpected fallback') }, isOpenAiFallbackConfigured: () => false },
  }
  const modules = new Map()
  async function link(specifier, referring) {
    const url = new URL(specifier, referring.identifier).href
    if (modules.has(url)) return modules.get(url)
    let module
    if (stubs[specifier]) {
      const values = stubs[specifier]
      module = new SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value)
      }, { context, identifier: url })
    } else {
      assert.ok(url.startsWith(new URL('../server/', import.meta.url).href), 'unexpected import')
      module = new SourceTextModule(await readFile(new URL(url), 'utf8'), { context, identifier: url })
    }
    modules.set(url, module)
    await module.link(link)
    return module
  }
  const footer = '\nexport { runAiFlow };\n' + (guardThrows ? 'deliveryDaysGuard = () => { throw new Error("injected guard failure") };\n' : '')
  const module = new SourceTextModule(source + footer, { context, identifier: processUrl.href })
  await module.link(link)
  await module.evaluate()
  const db = {
    messageLog: { count: async () => 0, findMany: async query => {
      if (!query.where.OR) return []
      assert.ok(query.where.OR.some(clause => clause.deferReason?.in.includes('manual_reply')))
      assert.ok(query.select.deferReason)
      return history.slice().reverse()
    }, findFirst: async () => null, create: async ({ data }) => { logs.push(data); return { id: 'log-test', ...data } } },
    settings: { update: async () => ({}) },
    knowledgeChunk: { findFirst: async () => null, findMany: async () => [] },
    buyerMemory: { findUnique: async () => null },
    buyerConversation: {
      findUnique: async () => ({ lastMessageAt: new Date(), cooldownUntil: cooldown && ++conversationReads > 1 ? new Date(Date.now() + 60000) : null }),
      upsert: async () => ({ id: 'conversation-test', isFirstTime: false }),
    },
    $queryRaw: async () => timedFacts, $executeRaw: async () => 0,
  }
  const anthropic = { messages: { create: async body => {
    if (body.model.includes('haiku')) return { content: [{ type: 'text', text: 'ASSISTANT' }], usage: { input_tokens: 1, output_tokens: 1 } }
    requests.push(body)
    calls++
    if (calls <= failCalls) throw Object.assign(Error('529 overloaded'), { status: 529 })
    return { content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: 8 } }
  } } }
  if (incomingText !== null) {
    await module.namespace.processIncomingMessage({ whatsappNumber: 'buyer-test', messages: [{ messageId: 'inbound-test', messageType: 'text', messageText: incomingText }], db, anthropic, settings: { isActive: true, dailyBudgetInr: 1500, systemPrompt: 'test rules', deferMessage: 'Ketu will reply shortly sir' } })
  } else {
    await module.namespace.runAiFlow({ whatsappNumber: 'buyer-test', mergedText: 'address kya hai', normalizedText: 'address kya hai', conversationId: 'conversation-test', db, anthropic, settings: { systemPrompt: 'test rules', deferMessage: 'Ketu will reply shortly sir' }, startTime: Date.now(), messageIds: ['inbound-test'] })
  }
  return { sent, logs, errors, requests, pending: module.namespace.pendingDefers }
}

const tests = [
  ['runtime omits an unnamed timing fact and preserves a named launch estimate', async () => {
    const date = new Date(Date.now() + 19800000).toISOString().slice(0, 10)
    const r = await runCase({ timedFacts: [
      { content: `[stated ${date}] Buyer asked: "Kab tak out of stock hai?" — Ketu's answer: "11-13 दिन में आ जाना चाहिए"` },
      { content: `[stated ${date}] Buyer asked: "Women range launch estimated time?" — Ketu's answer: "30 to 45 days max"` },
    ] })
    const prompt = r.requests[0].messages[0].content
    assert.doesNotMatch(prompt, /Kab tak out of stock|11-13/)
    assert.match(prompt, /Women range launch[^\n]*30-45 days/)
    assert.equal(r.sent.length, 1)
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
  }],
  ['retired catalogue URL is corrected inside the real output guard path', async () => {
    const r = await runCase({ reply: 'Current price sir 👉 https://sale91.com/catalog/p/hoodie-320gsm-black' })
    assert.equal(r.sent[0].message, 'Current price sir 👉 https://sale91.com/catalog/p/hoodie-320gsm')
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
    assert.match(r.requests[0].system.map(b => b.text).join('\n'), /Sale: Example.*Green: bulk 22 ₹63/)
  }],

  ['runtime uses current catalogue bands and excludes retired retrieved catalogue facts', async () => {
    const r = await runCase({ knowledge: [{ source: 'CATALOG', title: 'Retired Hoodie', content: 'Bulk price ₹199', similarity: 1, metadata: { slug: 'retired-hoodie', bulkPrice: 199 } }] })
    const system = r.requests[0].system.map(b => b.text).join('\n')
    assert.match(system, /Black: bulk M ₹211; XXL ₹223; sample ₹277/)
    assert.match(system, /White: bulk M ₹239; XXL ₹251; sample ₹299/)
    assert.doesNotMatch(system + r.requests[0].messages[0].content, /₹199|Retired Hoodie|retired-hoodie/)
    assert.equal(r.sent.length, 1)
  }],
  ['catalogue outage withholds stored prices while general replies still reach transport', async () => {
    const r = await runCase({ catalogUnavailable: true, knowledge: [{ source: 'CATALOG', title: 'Retired Hoodie', content: 'Bulk price ₹199', similarity: 1 }] })
    assert.match(r.requests[0].system.map(b => b.text).join('\n'), /CURRENT CATALOG UNAVAILABLE/)
    assert.doesNotMatch(r.requests[0].messages[0].content, /₹199|Retired Hoodie/)
    assert.equal(r.sent.length, 1)
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
  }],

  ['cart share with a discount question reaches the reply model', async () => {
    const r = await runCase({ incomingText: 'Total 400 pcs · 128 kg\nOversize 240gsm\nBlack M:200, L:200\nSelf-Pickup\nRef: wo_example\nKuch kam karvado', reply: 'Fixed price hai sir 🙏' })
    assert.equal(r.requests.length, 1)
    assert.match(r.requests[0].messages[0].content, /Kuch kam karvado/)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /Fixed price/)
    assert.notEqual(r.logs.at(-1).deferReason, 'cart_block_order_intent')
  }],
  ['cart share asking about the visible discount keeps its question', async () => {
    const r = await runCase({ incomingText: 'Total 120 pcs · 38 kg\nOversize 240gsm\nBlack M:60, L:60\nRef: wo_example\nWhy is the discount not applying?', reply: 'Discount video sir 👉 https://youtube.com/shorts/dnFWXQW5yqk' })
    assert.equal(r.requests.length, 1)
    assert.match(r.requests[0].messages[0].content, /Why is the discount not applying/)
    assert.match(r.sent[0].message, /dnFWXQW5yqk/)
  }],
  ['ordinary cart share keeps its immediate checkout reply', async () => {
    const r = await runCase({ incomingText: 'Total 120 pcs · 38 kg\nOversize 240gsm\nBlack M:60, L:60\nRef: wo_example\nYe order karna hai' })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 1)
    assert.equal(r.logs.at(-1).deferReason, 'cart_block_order_intent')
    assert.match(r.sent[0].message, /Order website pe place/)
    assert.doesNotMatch(r.sent[0].message, /dispatch|discount/i)
  }],
  ['cart discount question respects the manual-reply cooldown', async () => {
    const r = await runCase({ incomingText: 'Total 120 pcs · 38 kg\nOversize 240gsm\nBlack M:60, L:60\nRef: wo_example\nKuch kam karvado', cooldown: true })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.equal(r.logs.at(-1).status, 'COOLDOWN')
  }],
  ['runtime timing injection removes elapsed days before the model sees it', async () => {
    const date = new Date(Date.now() + 19800000 - 4 * 86400000).toISOString().slice(0, 10)
    const r = await runCase({ timedFacts: [{ content: `[stated ${date}] Buyer asked: "Oversize 240gsm Red restock?" — Ketu's answer: "8-9 din mein aayega"` }] })
    const prompt = r.requests[0].messages[0].content
    assert.match(prompt, /4-5 days/)
    assert.doesNotMatch(prompt, /8-9 din/)
    assert.equal(r.sent.length, 1)
    assert.equal(r.logs.at(-1).status, 'REPLIED')
  }],
  ['normal reply reaches transport and records sent status', async () => {
    const r = await runCase()
    assert.equal(r.sent.length, 1)
    assert.equal(r.logs.at(-1).status, 'REPLIED')
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
  }],
  ['overload recovery retries the original buyer request', async () => {
    const r = await runCase({ failCalls: 2 })
    assert.equal(r.sent.length, 1, r.errors.join('\n'))
    assert.equal(r.requests.length, 3)
    assert.deepEqual(r.requests[0].messages, r.requests[2].messages)
    assert.equal(r.pending.size, 0)
  }],
  ['total provider outage retains a visible deferred question', async () => {
    const r = await runCase({ failCalls: 100 })
    assert.equal(r.requests.length, 6, r.errors.join('\n'))
    assert.equal(r.sent.filter(x => x.whatsappNumber === 'buyer-test').length, 0)
    assert.equal(r.pending.size, 1)
  }],
  ['manual intervention during generation suppresses duplicate send', async () => {
    const r = await runCase({ cooldown: true })
    assert.equal(r.sent.length, 0)
    assert.equal(r.logs.at(-1).deferReason, 'superseded_by_intervention')
  }],
  ['guard exceptions do not release an unchecked model reply', async () => {
    const r = await runCase({ guardThrows: true })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.size, 1)
    assert.ok(r.errors.some(x => x.includes('injected guard failure')))
  }],
  ['owner replies reach the model without inventing a buyer turn', async () => {
    const r = await runCase({ history: [{ status: 'SKIPPED', deferReason: 'manual_reply', buyerMessage: 'stale-pair-must-not-be-replayed', aiReply: 'Use the alternate address I confirmed.', createdAt: '2026-09-10T10:00:00Z' }] })
    const prompt = r.requests[0].messages[0].content
    assert.match(prompt, /Ketu \(manual reply.*IST\): Use the alternate address I confirmed/)
    assert.doesNotMatch(prompt, /stale-pair-must-not-be-replayed/)
  }],
  ['a previously silenced buyer question remains visible in context', async () => {
    const r = await runCase({ history: [{ status: 'SKIPPED', deferReason: 'ai_chose_silence', buyerMessage: 'The side gate address please', aiReply: null }] })
    assert.match(r.requests[0].messages[0].content, /Buyer: The side gate address please\n\[No reply was sent/)
  }],
]
let failed = 0
for (const [name, test] of tests) {
  try { await test(); console.log(`PASS ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`) }
}
console.log(`${tests.length - failed}/${tests.length} reply-flow integration checks passed`)
process.exitCode = failed ? 1 : 0
