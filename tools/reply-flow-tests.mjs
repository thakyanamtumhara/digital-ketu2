import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm'

const processUrl = new URL('../server/process.js', import.meta.url)
const source = await readFile(processUrl, 'utf8')

async function runCase({ reply = 'Address sir: Khanpur.', failCalls = 0, guardThrows = false, cooldown = false, history = [], timedFacts = [], incomingText = null, incomingMessages = null, invoiceKind = 'FRESH', active = true, catalogUnavailable = false, knowledge = [], recovery = null, buyerText = 'address kya hai', rewriteReply = null, rewriteThrows = false, preferredLanguage = null } = {}) {
  const sent = [], logs = [], errors = [], requests = [], rewriteRequests = []
  const timers = [], recoveryQueries = []
  let clock = recovery?.now ?? Date.now()
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])) }
    static now() { return clock }
  }
  let calls = 0, conversationReads = 0
  const context = createContext({
    console: { log() {}, warn() {}, error(...args) { errors.push(args.join(' ')) } },
    process: { env: { WWBUN_API_URL: 'https://transport.invalid', DIGITAL_KETU_SECRET: 'test-only', OWNER_WHATSAPP: 'owner-test' } },
    Buffer, URL, Date: recovery ? TestDate : Date, AbortController, AbortSignal,
    setTimeout(fn, ms) { if (recovery) timers.push({ fn, ms }); else if (ms < 30000) queueMicrotask(fn); return { unref() {} } },
    clearTimeout() {},
    fetch: async (url, options) => {
      if (String(url).startsWith('https://media.invalid/')) return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(4) }
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
      if (recovery && query.where.deferReason === 'welcome_followup_scheduled') {
        recoveryQueries.push(query)
        const range = query.where.createdAt
        return recovery.rows.filter(row => +row.createdAt >= +range.gte && +row.createdAt <= +range.lte && (!range.lt || +row.createdAt < +range.lt))
      }
      if (!query.where.OR) return []
      assert.ok(query.where.OR.some(clause => clause.deferReason?.in.includes('manual_reply')))
      assert.ok(query.select.deferReason)
      return history.slice().reverse()
    }, findFirst: async () => recovery?.laterLog || null, create: async ({ data }) => { logs.push(data); return { id: 'log-test', ...data } } },
    settings: { update: async () => ({}), findUnique: async () => ({ isActive: recovery?.active !== false, replyModel: 'claude-opus-5', systemPrompt: 'test rules' }) },
    knowledgeChunk: { findFirst: async () => null, findMany: async () => [] },
    buyerMemory: { findUnique: async () => preferredLanguage ? { language: preferredLanguage } : null, upsert: async () => ({}) },
    buyerConversation: {
      findUnique: async () => ({ whatsappNumber: 'buyer-test', lastMessageAt: new Date(), cooldownUntil: recovery?.cooldown || (cooldown && ++conversationReads > 1 ? new Date(Date.now() + 60000) : null) }),
      upsert: async () => ({ id: 'conversation-test', isFirstTime: false }),
    },
    $queryRaw: async () => timedFacts, $executeRaw: async () => 0,
  }
  const anthropic = { messages: { create: async body => {
    if (Array.isArray(body.messages?.[0]?.content) && body.max_tokens === 10) return { content: [{ type: 'text', text: invoiceKind }], usage: { input_tokens: 1, output_tokens: 1 } }
    if (typeof body.messages?.[0]?.content === 'string' && body.messages[0].content.startsWith('Rewrite this WhatsApp reply')) {
      rewriteRequests.push(body)
      if (rewriteThrows) throw Error('rewrite unavailable')
      return { content: [{ type: 'text', text: rewriteReply || '' }], usage: { input_tokens: 4, output_tokens: 4 } }
    }
    if (body.model.includes('haiku')) return { content: [{ type: 'text', text: 'ASSISTANT' }], usage: { input_tokens: 1, output_tokens: 1 } }
    requests.push(body)
    calls++
    if (calls <= failCalls) throw Object.assign(Error('529 overloaded'), { status: 529 })
    return { content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: 8 } }
  } } }
  if (recovery) {
    if (recovery.pending) module.namespace.pendingWelcomeFollowups.set('buyer-test', { timer: {}, mergedText: 'new question' })
    if (recovery.direct) await module.namespace.recoverPendingFollowups({ db, anthropic, bootedAt: recovery.bootedAt })
    else {
      module.namespace.schedulePendingFollowupRecovery({ db, anthropic, bootedAt: recovery.bootedAt })
      assert.equal(timers.length, 1)
      clock += timers[0].ms
      await timers[0].fn()
    }
  } else if (incomingText !== null || incomingMessages) {
    await module.namespace.processIncomingMessage({ whatsappNumber: 'buyer-test', messages: incomingMessages || [{ messageId: 'inbound-test', messageType: 'text', messageText: incomingText }], db, anthropic, settings: { isActive: active, partialAiEnabled: !active, dailyBudgetInr: 1500, systemPrompt: 'test rules', deferMessage: 'Ketu will reply shortly sir' } })
  } else {
    await module.namespace.runAiFlow({ whatsappNumber: 'buyer-test', mergedText: buyerText, normalizedText: buyerText, conversationId: 'conversation-test', db, anthropic, settings: { systemPrompt: 'test rules', deferMessage: 'Ketu will reply shortly sir' }, startTime: Date.now(), messageIds: ['inbound-test'] })
  }
  return { sent, logs, errors, requests, rewriteRequests, pending: module.namespace.pendingDefers, recoveryQueries, timerDelays: timers.map(t => t.ms) }
}

const tests = [
  ['bill PDF with a photo is held in full and partial AI', async () => {
    for (const active of [true, false]) {
      const r = await runCase({ active, incomingMessages: [
        { messageId: 'bill-test', messageType: 'document', messageText: '[Document: Invoice_Example.pdf]' },
        { messageId: 'photo-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/goods.jpg' },
      ] })
      assert.equal(r.sent.length, 0)
      assert.equal(r.requests.length, 0)
      const held = r.pending.get('buyer-test')?.messages[0]
      assert.ok(held)
      assert.deepEqual(Array.from(held.messageIds), ['bill-test', 'photo-test'])
      assert.equal(held.logData.status, 'DEFERRED')
    }
  }],
  ['bare bill PDF keeps the normal acknowledgement in both modes', async () => {
    for (const active of [true, false]) {
      const r = await runCase({ active, incomingMessages: [
        { messageId: 'bill-test', messageType: 'document', messageText: '[Document: Invoice_Example.pdf]' },
      ] })
      assert.equal(r.pending.size, 0)
      assert.equal(r.sent[0].message, 'Ok noted sir, dispatching ASAP 🚚')
      assert.equal(r.logs.at(-1).deferReason, 'bill_document')
    }
  }],
  ['companion photo placeholders remain evidence even without a second media URL', async () => {
    for (const messageText of ['[Image] [Image]', '[Image] [product photo]']) {
      const r = await runCase({ incomingMessages: [
        { messageId: 'invoice-test', messageType: 'image', messageText, mediaUrl: 'https://media.invalid/invoice.jpg' },
      ] })
      assert.equal(r.sent.length, 0)
      assert.equal(r.pending.get('buyer-test').messages[0].logData.deferReason, 'bill_with_companion_photo')
    }
  }],
  ['partial AI retains the invoice companion-photo boundary', async () => {
    const r = await runCase({ active: false, incomingMessages: [
      { messageId: 'invoice-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/invoice.jpg' },
      { messageId: 'goods-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/goods.jpg' },
    ] })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.get('buyer-test').messages[0].logData.deferReason, 'bill_with_nondispatch_text')
  }],
  ['an invoice with goods in the same frame retains its existing handoff', async () => {
    const r = await runCase({ invoiceKind: 'STALE', incomingMessages: [
      { messageId: 'invoice-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/invoice.jpg' },
    ] })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.get('buyer-test').messages[0].logData.deferReason, 'bill_photographed_with_goods')
  }],
  ['ordinary product photos still reach the reply model', async () => {
    const r = await runCase({ invoiceKind: 'NO', reply: 'See these colours in the catalogue sir.', incomingMessages: [
      { messageId: 'first-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/product-one.jpg' },
      { messageId: 'second-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/product-two.jpg' },
      { messageId: 'text-test', messageType: 'text', messageText: 'Please share these product colours' },
    ] })
    assert.equal(r.pending.size, 0)
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent[0].message, 'See these colours in the catalogue sir.')
  }],
  ['manual cooldown stays ahead of the invoice companion-photo guard', async () => {
    const r = await runCase({ cooldown: true, incomingMessages: [
      { messageId: 'invoice-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/invoice.jpg' },
      { messageId: 'goods-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/goods.jpg' },
    ] })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.size, 0)
    assert.equal(r.logs.at(-1).status, 'COOLDOWN')
  }],
  ['invoice screenshot with a companion goods photo cannot dispatch-ack', async () => {
    const r = await runCase({ incomingMessages: [
      { messageId: 'invoice-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/invoice.jpg' },
      { messageId: 'text-test', messageType: 'text', messageText: 'Order kiya hai' },
      { messageId: 'goods-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/goods.jpg' },
    ] })
    assert.equal(r.sent.length, 0)
    assert.equal(r.requests.length, 0)
    const held = r.pending.get('buyer-test')?.messages[0]
    assert.ok(held)
    assert.equal(held.logData.deferReason, 'bill_with_companion_photo')
    assert.deepEqual(Array.from(held.messageIds), ['invoice-test', 'text-test', 'goods-test'])
  }],
  ['single fresh invoice keeps its immediate dispatch acknowledgement', async () => {
    const r = await runCase({ incomingMessages: [
      { messageId: 'invoice-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/invoice.jpg' },
      { messageId: 'text-test', messageType: 'text', messageText: 'Order kiya hai' },
    ] })
    assert.equal(r.pending.size, 0)
    assert.equal(r.sent[0].message, 'Ok noted sir, dispatching ASAP 🚚')
    assert.equal(r.logs.at(-1).deferReason, 'bill_document')
    assert.equal(r.requests.length, 0)
  }],
  ['arrival deadline is held with its inbound ID and cost', async () => {
    const r = await runCase({ buyerText: 'Order 4 baje tak deliver karva dena', reply: 'Ok sir, 4 baje tak deliver karva denge 🚚' })
    assert.equal(r.sent.length, 0)
    const held = r.pending.get('buyer-test')?.messages[0]
    assert.ok(held)
    assert.equal(held.logData.deferReason, 'arrival_clock_blocked')
    assert.ok(held.logData.costUsd > 0)
    assert.ok(held.messageIds.includes('inbound-test'))
  }],
  ['dispatch override cannot release a blocked arrival promise', async () => {
    const r = await runCase({ buyerText: 'Aaj dispatch hoga? 4 baje tak deliver karna', reply: '4 baje tak deliver karva denge sir' })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.size, 1)
    assert.equal(r.pending.get('buyer-test').messages[0].logData.deferReason, 'arrival_clock_blocked')
  }],
  ['arrival guard retains a separate answer alongside the handoff', async () => {
    const r = await runCase({ buyerText: 'Catalogue bhejo aur parcel 4 baje tak deliver karna', reply: 'Catalogue yahan hai sir https://sale91.com/catalog. Parcel 4 baje tak pahunch jayega.' })
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0].message, 'Catalogue yahan hai sir https://sale91.com/catalog.')
    assert.equal(r.pending.size, 1)
    assert.equal(r.pending.get('buyer-test').messages[0].logData.costUsd, 0)
    assert.ok(r.logs.at(-1).costUsd > 0)
  }],
  ['generic bike duration remains answerable', async () => {
    const reply = 'Delhi bike delivery takes 1-2 hours sir.'
    const r = await runCase({ buyerText: 'Delhi bike delivery how long?', reply })
    assert.equal(r.sent[0].message, reply)
    assert.equal(r.pending.size, 0)
  }],
  ['authorized dispatch status survives the arrival guard', async () => {
    const reply = 'Aaj hi dispatch hua hai sir.'
    const r = await runCase({ buyerText: 'Dispatch hua?', reply, history: [{ status: 'SKIPPED', deferReason: 'manual_reply', buyerMessage: 'old pairing', aiReply: 'Dispatched today', createdAt: new Date().toISOString() }] })
    assert.equal(r.sent[0].message, reply)
    assert.equal(r.pending.size, 0)
  }],
  ['store and call hours survive the arrival guard', async () => {
    const reply = 'Shop opens at 10 am. Call after 10 am sir.'
    const r = await runCase({ buyerText: 'When can I call or visit?', reply })
    assert.equal(r.sent[0].message, reply)
    assert.equal(r.pending.size, 0)
  }],
  ['English address repair preserves the warehouse name through transport', async () => {
    const r = await runCase({ buyerText: 'Please give the warehouse address', reply: 'Location pe TSHIRT WALA GODAM poochh lena sir', rewriteReply: 'Ask for TSHIRT WALA GODAM when you arrive sir' })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, 'Ask for TSHIRT WALA GODAM when you arrive sir')
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
  }],
  ['a translated warehouse name is rejected before transport', async () => {
    const original = 'Location pe TSHIRT WALA GODAM poochh lena sir'
    const r = await runCase({ buyerText: 'Please give the warehouse address', reply: original, rewriteReply: 'Ask for TSHIRT WAREHOUSE when you arrive sir' })
    assert.equal(r.sent[0].message, original)
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
  }],
  ['one-word location request is repaired after an unknown greeting', async () => {
    const r = await runCase({ buyerText: 'Location', history: [{ buyerMessage: 'Heyy', aiReply: 'Ask me sir' }], reply: 'Yahan pe aa jaiye sir', rewriteReply: 'Please come here sir' })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, 'Please come here sir')
  }],
  ['Hindi size range in an English reply is repaired before transport', async () => {
    const r = await runCase({ buyerText: 'Please share hoodie details', reply: 'Sizes S se XXL sir', rewriteReply: 'Sizes S to XXL sir' })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, 'Sizes S to XXL sir')
  }],
  ['short English contact request is repaired before actual transport', async () => {
    const r = await runCase({ buyerText: 'Could I get contact information?', reply: 'Call kar lijiye sir 👉 1234567890', rewriteReply: 'Please call sir 👉 1234567890' })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, 'Please call sir 👉 1234567890')
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
    assert.ok(r.logs.at(-1).costUsd > 0)
  }],
  ['short answer inherits buyer English without inheriting assistant Hinglish', async () => {
    const r = await runCase({ buyerText: 'Heavyweight', reply: 'Oversize hai sir', rewriteReply: 'Oversize is available sir', history: [{ buyerMessage: 'We need some shirts', aiReply: 'Kaunsa product chahiye?', status: 'REPLIED' }] })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, 'Oversize is available sir')
  }],
  ['current Hinglish answer is not rewritten because an earlier turn was English', async () => {
    const r = await runCase({ buyerText: 'Mujhe heavyweight chahiye', reply: 'Oversize hai sir', history: [{ buyerMessage: 'We need some shirts', status: 'REPLIED' }] })
    assert.equal(r.rewriteRequests.length, 0)
    assert.equal(r.sent[0].message, 'Oversize hai sir')
  }],
  ['stored explicit Hindi preference survives an English-shaped contact ask', async () => {
    const r = await runCase({ buyerText: 'Could I get contact information?', preferredLanguage: 'hindi', reply: 'Call kar lijiye sir' })
    assert.equal(r.rewriteRequests.length, 0)
  }],
  ['rewrite failure preserves the original answer and delivery', async () => {
    const r = await runCase({ buyerText: 'Could I get contact information?', reply: 'Call kar lijiye sir', rewriteThrows: true })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, 'Call kar lijiye sir')
    assert.equal(r.logs.at(-1).status, 'REPLIED')
  }],
  ['English rewriting cannot override a guard-failure handoff', async () => {
    const r = await runCase({ buyerText: 'Could I get contact information?', reply: 'Call kar lijiye sir', guardThrows: true })
    assert.equal(r.rewriteRequests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.get('buyer-test').messages[0].logData.deferReason, 'post_model_guard_failed')
  }],
  ['startup recovery waits until a pre-restart question is due and sends through the real flow', async () => {
    const boot = Date.parse('2026-09-11T14:00:00Z')
    const r = await runCase({ reply: 'You can order samples from the website sir.', recovery: {
      now: boot, bootedAt: new Date(boot).toISOString(), rows: [{ id: 'scheduled-test', conversationId: 'conversation-test', buyerMessage: 'How many pieces can I order?', createdAt: new Date(boot - 19000), messageIds: ['original-inbound-test'] }],
    } })
    assert.ok(r.timerDelays[0] >= 60000)
    assert.equal(r.sent.length, 1)
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
    assert.deepEqual(Array.from(r.logs.at(-1).messageIds), ['original-inbound-test'])
    assert.equal(r.requests[0].model, 'claude-opus-5')
    assert.match(r.requests[0].messages[0].content, /How many pieces can I order/)
  }],
  ...[
    ['an already completed follow-up', { laterLog: { id: 'completed-reply' } }],
    ['a later manual answer even after its cooldown expires', { laterLog: { id: 'manual-reply' } }],
    ['an active manual cooldown', { cooldown: new Date('2026-09-11T14:10:00Z') }],
    ['an active welcome timer', { pending: true }],
    ['disabled AI', { active: false }],
  ].map(([name, extra]) => [`startup recovery leaves ${name} alone`, async () => {
    const boot = Date.parse('2026-09-11T14:00:00Z')
    const r = await runCase({ recovery: {
      now: boot, bootedAt: new Date(boot).toISOString(), rows: [{ id: 'scheduled-test', conversationId: 'conversation-test', buyerMessage: 'How many pieces can I order?', createdAt: new Date(boot - 19000) }], ...extra,
    } })
    assert.equal(r.sent.length, 0)
    assert.equal(r.requests.length, 0)
  }]),
  ...[
    ['a timer scheduled at startup', 0],
    ['a timer owned by the new process', 1000],
    ['a stale question outside the recovery window', -16 * 60000],
  ].map(([name, offset]) => [`startup recovery excludes ${name}`, async () => {
    const boot = Date.parse('2026-09-11T14:00:00Z')
    const r = await runCase({ recovery: {
      now: boot, bootedAt: new Date(boot).toISOString(), rows: [{ id: 'scheduled-test', conversationId: 'conversation-test', buyerMessage: 'How many pieces can I order?', createdAt: new Date(boot + offset) }],
    } })
    assert.equal(r.sent.length, 0)
    assert.equal(r.requests.length, 0)
  }]),
  ['startup recovery sends one free greeting for duplicate scheduled rows', async () => {
    const boot = Date.parse('2026-09-11T14:00:00Z')
    const r = await runCase({ recovery: {
      now: boot, bootedAt: new Date(boot).toISOString(), rows: [-19000, -21000].map((offset, i) => ({ id: `scheduled-${i}`, conversationId: 'conversation-test', buyerMessage: 'Hello', createdAt: new Date(boot + offset) })),
    } })
    assert.equal(r.sent.length, 1)
    assert.equal(r.requests.length, 0)
    assert.equal(r.logs.at(-1).deferReason, 'welcome_followup_recovered_generic')
  }],
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
  ['short address typo is repaired before transport', async () => {
    const r = await runCase({ buyerText: 'Hello store adresss pls?', reply: 'Location pe TSHIRT WALA GODAM poochh lena sir', rewriteReply: 'Ask for TSHIRT WALA GODAM when you arrive sir' })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, 'Ask for TSHIRT WALA GODAM when you arrive sir')
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
  }],
  ['short catalogue request is repaired before transport', async () => {
    const r = await runCase({ buyerText: 'Hello catalogue', reply: 'Catalog dekh lijiye sir 👉 https://sale91.com/catalog', rewriteReply: 'See the catalog sir 👉 https://sale91.com/catalog' })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, 'See the catalog sir 👉 https://sale91.com/catalog')
  }],
  ['short address keeps an explicit Hindi preference', async () => {
    const r = await runCase({ buyerText: 'Hello store address', preferredLanguage: 'hindi', reply: 'Location pe TSHIRT WALA GODAM poochh lena sir' })
    assert.equal(r.rewriteRequests.length, 0)
    assert.match(r.sent[0].message, /poochh lena/)
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
