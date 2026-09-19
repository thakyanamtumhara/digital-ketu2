import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm'
import { resolveTimedFactProduct, detectColoursAndSizes, PRODUCT_NAMED_RE, formatStockBlock, resolveUnnamedProduct, unnamedProductCandidates, unnamedProductGuard } from '../server/stock-lookup.js'

const processUrl = new URL('../server/process.js', import.meta.url)
const source = await readFile(processUrl, 'utf8')

async function runCase({ firstContact = false, whatsappNumber = 'buyer-test', reply = 'Address sir: Khanpur.', failCalls = 0, guardThrows = false, cooldown = false, history = [], guardHistory = null, timedFacts = [], stockSnapshot = null, stockThrows = false, realStockResolver = false, incomingText = null, incomingMessages = null, invoiceKind = 'FRESH', active = true, catalogUnavailable = false, catalogData = null, knowledge = [], recovery = null, buyerText = 'address kya hai', rewriteReply = null, rewriteThrows = false, preferredLanguage = null, imageUrl = null, mediaAvailable = true, gateVerdict = 'ASSISTANT', repliesToday = 0, keywordFilters = [], outboundHistory = [] } = {}) {
  const sent = [], logs = [], errors = [], requests = [], rewriteRequests = []
  const restraintRequests = [], handled = []
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
    setTimeout(fn, ms) { timers.push({ fn, ms }); if (!recovery && ms < 30000) queueMicrotask(fn); return { unref() {} } },
    clearTimeout() {},
    fetch: async (url, options) => {
      if (String(url) === 'https://transport.invalid/api/conversations/mark-handled') { handled.push(JSON.parse(options.body)); return { ok: true } }
      if (String(url).startsWith('https://media.invalid/')) return { ok: mediaAvailable, status: mediaAvailable ? 200 : 404, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(4) }
      if (String(url).startsWith('https://www.bulkplaintshirt.com/catalog/products.json?')) {
        if (catalogUnavailable) throw Error('catalog unavailable')
        if (catalogData) return { ok: true, json: async () => catalogData }
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
    './stock-lookup.js': { getStockSnapshot: async () => { if (stockThrows) throw Error('stock unavailable'); return stockSnapshot || {} }, formatStockBlock: snapshot => stockSnapshot ? formatStockBlock(snapshot, { timedFacts }) : '', resolveUnnamedProduct: realStockResolver ? resolveUnnamedProduct : () => '', unnamedProductCandidates: realStockResolver ? unnamedProductCandidates : () => [], unnamedProductGuard: realStockResolver ? unnamedProductGuard : () => null, resolveTimedFactProduct, detectColoursAndSizes, PRODUCT_NAMED_RE },
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
    messageLog: { count: async () => repliesToday, findMany: async query => {
      if (recovery && query.where.deferReason === 'welcome_followup_scheduled') {
        recoveryQueries.push(query)
        const range = query.where.createdAt
        return recovery.rows.filter(row => +row.createdAt >= +range.gte && +row.createdAt <= +range.lte && (!range.lt || +row.createdAt < +range.lt))
      }
      if (guardHistory && !query.where.OR) {
        const range = query.where.createdAt
        return guardHistory.filter(row => (!range?.gt || +new Date(row.createdAt) > +range.gt) && (!range?.gte || +new Date(row.createdAt) >= +range.gte))
          .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, query.take)
      }
      if (query.select?.status && query.select.createdAt && !query.where.OR) return outboundHistory
      if (query.where.status?.in) return history.filter(row => query.where.status.in.includes(row.status)).slice().reverse().slice(0, query.take)
      if (!query.where.OR) return []
      assert.ok(query.where.OR.some(clause => clause.deferReason?.in.includes('manual_reply')))
      assert.ok(query.select.deferReason)
      return history.slice().reverse()
    }, findFirst: async () => recovery?.laterLog || null, create: async ({ data }) => { logs.push(data); return { id: 'log-test', ...data } } },
    settings: { update: async () => ({}), findUnique: async () => ({ isActive: recovery?.active !== false, replyModel: 'claude-opus-5', systemPrompt: 'test rules' }) },
    preAIFilter: { findMany: async () => keywordFilters },
    knowledgeChunk: { findFirst: async () => null, findMany: async () => [] },
    buyerMemory: { findUnique: async () => preferredLanguage ? { language: preferredLanguage } : null, upsert: async () => ({}) },
    buyerConversation: {
      findUnique: async query => firstContact && query.select?.lastMessageAt ? null : ({ whatsappNumber, lastMessageAt: new Date(), cooldownUntil: recovery?.cooldown || (cooldown && ++conversationReads > 1 ? new Date(Date.now() + 60000) : null) }),
      upsert: async () => ({ id: 'conversation-test', isFirstTime: false }),
    },
    $queryRaw: async () => timedFacts, $executeRaw: async () => 0,
  }
  const anthropic = { messages: { create: async body => {
    if (typeof body.messages?.[0]?.content === 'string' && body.messages[0].content.startsWith('You decide whether Om')) {
      restraintRequests.push(body)
      return { content: [{ type: 'text', text: gateVerdict }], usage: { input_tokens: 1, output_tokens: 1 } }
    }
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
    await module.namespace.processIncomingMessage({ whatsappNumber, messages: incomingMessages || [{ messageId: 'inbound-test', messageType: 'text', messageText: incomingText }], db, anthropic, settings: { isActive: active, partialAiEnabled: !active, dailyBudgetInr: 1500, systemPrompt: 'test rules', deferMessage: 'Ketu will reply shortly sir' } })
  } else {
    await module.namespace.runAiFlow({ whatsappNumber, mergedText: buyerText, normalizedText: buyerText, imageUrl, conversationId: 'conversation-test', db, anthropic, settings: { systemPrompt: 'test rules', deferMessage: 'Ketu will reply shortly sir' }, startTime: Date.now(), messageIds: ['inbound-test'] })
  }
  return { sent, logs, errors, requests, rewriteRequests, restraintRequests, handled, pending: module.namespace.pendingDefers, recoveryQueries, timerDelays: timers.map(t => t.ms) }
}

const blueCatalog = { categories: [{ products: [{
  name: 'True Biowash Round Neck', slug: 'true-biowash-round-neck', gsm: 180,
  description: 'Regular Fit, True Biowash Round neck, 180gsm',
  colors: ['Black', 'Navy', 'Royal Blue', 'Sky'], sizes: ['36', '38', '40', '42'],
  rates: [{ colors: ['Black', 'Navy', 'Royal Blue', 'Sky'], pricePerSize: { 36: 158, 38: 158, 40: 158, 42: 158 }, samplePrice: 195 }],
}] }] }

const pluralStockSnapshot = {
  inStock: {
    Sweatshirt: { Black: { M: 1 }, Navy: { M: 1 } },
    'Oversize 240gsm': { Black: { M: 1 } },
    Shorts: { Black: { M: 1 } },
    'Hoodie 320gsm-1': { Black: { M: 1 } },
  },
  oos: { Sweatshirt: { Navy: 'M' } }, coming: {}, fetchedAt: Date.now(),
}
const tests = [
  ['English colour relation repairs the reply before transport', async () => {
    const fixed = 'Navy and Black are listed sir 👉 https://example.invalid/product'
    const r = await runCase({ buyerText: 'Cotton shirts in Navy and Black colours', reply: 'Navy aur Black hain sir 👉 https://example.invalid/product', rewriteReply: fixed })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, fixed)
    assert.equal(r.logs.at(-1).aiReply, fixed)
    assert.deepEqual(r.errors, [])
  }],
  ['English delivery estimate repairs Hindi output after Hindi history', async () => {
    const fixed = 'Usually 2-3 days sir; check the delivery date at checkout 👉 https://example.invalid/order'
    const r = await runCase({ buyerText: 'Estimate delivery time to Pune?', reply: 'Usually 2-3 din sir; checkout pe delivery date dekhiye 👉 https://example.invalid/order', rewriteReply: fixed, history: [{ buyerMessage: 'Mujhe shirts chahiye', aiReply: 'Check the catalogue sir', status: 'REPLIED' }] })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, fixed)
    assert.equal(r.logs.at(-1).aiReply, fixed)
    assert.deepEqual(r.errors, [])
  }],
  ['estimate request preserves explicit Hindi and owner handoff boundaries', async () => {
    const reply = 'Usually 2-3 din mein milega sir'
    const r = await runCase({ buyerText: 'Estimate delivery time?', reply, preferredLanguage: 'hindi' })
    assert.equal(r.rewriteRequests.length, 0)
    assert.equal(r.sent[0].message, reply)
    const held = await runCase({ buyerText: 'Estimate delivery time for my missing parcel?', reply: '[DEFER]' })
    assert.equal(held.rewriteRequests.length, 0)
    assert.equal(held.sent.length, 0)
    assert.equal(held.pending.size, 1)
  }],
  ['bare payment destination images hand off without a dispatch acknowledgement', async () => {
    for (const active of [true, false]) {
      const r = await runCase({ active, invoiceKind: 'PAYMENT', incomingMessages: [
        { messageId: 'payment-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/payment-qr.jpg' },
      ] })
      assert.equal(r.sent.length, 0)
      assert.equal(r.requests.length, 0)
      const held = r.pending.get('buyer-test')?.messages[0]
      assert.equal(held?.logData.deferReason, 'payment_details_image')
      assert.equal(held?.logData.isMedia, true)
      assert.deepEqual(Array.from(held.messageIds), ['payment-test'])
      assert.deepEqual(r.errors, [])
    }
  }],
  ['payment destination with a real question still reaches full triage', async () => {
    const r = await runCase({ invoiceKind: 'PAYMENT', reply: 'Cotton Polo size chart: https://sale91.com/catalog/p/cotton-polo', incomingMessages: [
      { messageId: 'payment-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/payment-qr.jpg' },
      { messageId: 'question-test', messageType: 'text', messageText: 'Please send the Cotton Polo size chart' },
    ] })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /sale91.com\/catalog/)
    assert.doesNotMatch(r.sent[0].message, /dispatch/i)
    assert.equal(r.pending.size, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['payment destination does not bypass manual cooldown', async () => {
    const r = await runCase({ cooldown: true, invoiceKind: 'PAYMENT', incomingMessages: [
      { messageId: 'payment-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/payment-qr.jpg' },
    ] })
    assert.equal(r.sent.length, 0)
    assert.equal(r.requests.length, 0)
    assert.equal(r.pending.size, 0)
    assert.equal(r.logs.at(-1).status, 'COOLDOWN')
  }],
  ['conditional alert reminder hands an unresolved restock date to the owner', async () => {
    const history = [{ buyerMessage: 'Acid wash restock kab?', aiReply: 'Acid wash ka date nahi hai sir. Alert laga lijiye https://www.bulkplaintshirt.com/delhi-stock.html?alert=1', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }]
    for (const reply of ['Date nahi bata sakta sir; alert laga diya hai to stock aate hi WhatsApp aa jayega', 'Exact date nahi bata sakta sir, alert laga rakhiye, stock aate hi WhatsApp aa jayega']) {
      const r = await runCase({ buyerText: 'Approx kab aayega, 2 week mein?', history, reply })
      assert.equal(r.sent.length, 0)
      assert.equal(r.pending.size, 1)
      assert.equal([...r.pending.values()][0].messages[0].logData.deferReason, 'restock_pointer_handoff')
      assert.equal(r.requests.length, 1)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['first conditional stock reminder keeps the usable alert offer', async () => {
    const r = await runCase({ buyerText: 'Acid wash restock kab?', reply: 'Date nahi bata sakta sir; alert laga diya hai to stock aate hi WhatsApp aa jayega' })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /delhi-stock\.html\?alert=1/)
    assert.equal(r.pending.size, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['fresh estimate survives a conditional stock reminder', async () => {
    const history = [{ buyerMessage: 'Acid wash restock kab?', aiReply: 'Acid wash ka date nahi hai sir. Alert laga lijiye https://www.bulkplaintshirt.com/delhi-stock.html?alert=1', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }]
    const r = await runCase({ buyerText: 'Approx kab aayega?', history, reply: '3 din mein aayega sir; alert laga diya hai to stock aate hi WhatsApp aa jayega' })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /3 din/)
    assert.equal(r.pending.size, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['old delay history does not defer a fresh bare bill in either mode', async () => {
    for (const active of [true, false]) {
      for (const ageDays of [8, 48]) {
        const guardHistory = [{ buyerMessage: 'Parcel mein delay hai', status: 'DEFERRED', createdAt: new Date(Date.now() - ageDays * 86400000) }]
        const r = await runCase({ active, guardHistory, incomingText: '[Document: Invoice_new.pdf]' })
        assert.equal(r.sent.length, 1)
        assert.equal(r.logs.at(-1).deferReason, 'bill_document')
        assert.equal(r.pending.size, 0)
        assert.equal(r.requests.length, 0)
        assert.deepEqual(r.errors, [])
      }
    }
  }],
  ['prospective stock wait does not turn a fresh bill into a shipment complaint', async () => {
    const buyerMessage = 'Sir mujhe navy color ki hoodie order karni hai lekin size available nahi hai to kab tak rukna padega? Ya pehle se order laga sakte hai?'
    for (const active of [true, false]) {
      const guardHistory = [{ buyerMessage, status: 'REPLIED', createdAt: new Date(Date.now() - 86400000) }]
      const r = await runCase({ active, guardHistory, incomingText: '[Document: Invoice_new.pdf]' })
      assert.equal(r.sent.length, 1)
      assert.equal(r.logs.at(-1).deferReason, 'bill_document')
      assert.equal(r.pending.size, 0)
      assert.equal(r.requests.length, 0)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['stock wait exception preserves a separate or mixed shipment complaint', async () => {
    const buyerMessage = 'Sir mujhe navy color ki hoodie order karni hai lekin size available nahi hai to kab tak rukna padega?'
    for (const active of [true, false]) {
      for (const mixed of [true, false]) {
        const stock = { buyerMessage, status: 'REPLIED', createdAt: new Date(Date.now() - 86400000) }
        const guardHistory = mixed ? [{ ...stock, buyerMessage: buyerMessage + ' Parcel abhi tak nahi aaya' }] : [stock, { ...stock, buyerMessage: 'Parcel abhi tak nahi aaya' }]
        const r = await runCase({ active, guardHistory, incomingText: '[Document: Invoice_new.pdf]' })
        assert.equal(r.sent.length, 0)
        assert.equal(r.pending.size, 1)
        assert.equal(r.requests.length, 0)
        assert.deepEqual(r.errors, [])
      }
    }
  }],
  ['fresh invoice image shares the prospective-stock history exception', async () => {
    const guardHistory = [{ buyerMessage: 'Sir mujhe navy color ki hoodie order karni hai lekin size available nahi hai to kab tak rukna padega?', status: 'REPLIED', createdAt: new Date(Date.now() - 86400000) }]
    const r = await runCase({ guardHistory, invoiceKind: 'FRESH', incomingMessages: [{ messageId: 'invoice-stock-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/invoice.jpg' }] })
    assert.equal(r.sent.length, 1)
    assert.equal(r.pending.size, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['delay complaints within the past week still protect bare bills', async () => {
    for (const active of [true, false]) {
      const guardHistory = [{ buyerMessage: 'Parcel mein delay hai', status: 'REPLIED', createdAt: new Date(Date.now() - 6 * 86400000) }]
      const r = await runCase({ active, guardHistory, incomingText: '[Document: Invoice_new.pdf]' })
      assert.equal(r.sent.length, 0)
      assert.equal(r.pending.size, 1)
      assert.equal(r.requests.length, 0)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['current owner handling protects bills without delay vocabulary', async () => {
    for (const active of [true, false]) {
      const guardHistory = [{ buyerMessage: 'Please check this', aiReply: 'Checking', status: 'SKIPPED', deferReason: 'manual_reply', createdAt: new Date(Date.now() - 3600000) }]
      const r = await runCase({ active, guardHistory, incomingText: '[Document: Invoice_new.pdf]' })
      assert.equal(r.sent.length, 0)
      assert.equal(r.pending.size, 1)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['current bill complaint is not erased with old history', async () => {
    for (const active of [true, false]) {
      const guardHistory = [{ buyerMessage: 'Old parcel delay', status: 'DEFERRED', createdAt: new Date(Date.now() - 48 * 86400000) }]
      const r = await runCase({ active, guardHistory, incomingText: '[Document: Invoice_new.pdf] Wrong size received, replace it' })
      assert.equal(r.sent.length, 0)
      assert.equal(r.pending.size, 1)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['invoice image keeps the same old-versus-recent delay boundary', async () => {
    for (const ageDays of [6, 48]) {
      const guardHistory = [{ buyerMessage: 'Parcel delay', status: 'REPLIED', createdAt: new Date(Date.now() - ageDays * 86400000) }]
      const r = await runCase({ guardHistory, invoiceKind: 'FRESH', incomingMessages: [{ messageId: 'invoice-age-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/invoice.jpg' }] })
      assert.equal(r.sent.length, ageDays === 48 ? 1 : 0)
      assert.equal(r.pending.size, ageDays === 48 ? 0 : 1)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['nearest metro question reaches the answer model despite a silent gate', async () => {
    const r = await runCase({ incomingText: 'Nearest metro station please?', gateVerdict: 'SILENT', reply: 'Saket metro sir.', history: [{ buyerMessage: 'Your Delhi address', aiReply: 'Our warehouse is in Khanpur, Delhi.', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.requests.length, 1)
    assert.equal(r.restraintRequests.length, 0)
    assert.equal(r.sent[0]?.message, 'Saket metro sir.')
    assert.equal(r.handled.length, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['near metro fragment is answerable without a question mark', async () => {
    const r = await runCase({ incomingText: 'Near metro station', gateVerdict: 'SILENT', reply: 'Saket metro sir.' })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
  }],
  ['metro acknowledgement retains the silence decision', async () => {
    const r = await runCase({ incomingText: 'Saket metro thanks', gateVerdict: 'SILENT' })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.equal(r.logs.at(-1).deferReason, 'ai_chose_silence')
  }],
  ['metro question keeps owner cooldown and the daily reply cap', async () => {
    const r = await runCase({ incomingText: 'Nearest metro station?', cooldown: true })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.equal(r.handled.length, 0)
    assert.equal(r.logs[0].status, 'COOLDOWN')
    const capped = await runCase({ buyerText: 'Nearest metro station?', repliesToday: 25 })
    assert.equal(capped.requests.length, 0)
    assert.equal(capped.logs[0].deferReason, 'daily_reply_cap')
  }],
  ['metro routing keeps an owner-only reply as a handoff', async () => {
    const r = await runCase({ incomingText: 'Nearest metro station?', gateVerdict: 'SILENT', reply: '[DEFER]' })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.size, 1)
    assert.equal(r.handled.length, 0)
  }],
  ['plural sweatshirt keeps its named-product reply through the actual guards', async () => {
    const r = await runCase({ realStockResolver: true, stockSnapshot: pluralStockSnapshot,
      buyerText: 'Sweatshirts black ke alava kab stock mein vapas aayenge?',
      reply: 'Sweatshirt mein baaki colours abhi out of stock hain sir, alert laga lijiye.' })
    assert.equal(r.sent.length, 1)
    assert.doesNotMatch(JSON.stringify(r.requests), /PRODUCT NOT NAMED/)
    assert.doesNotMatch(r.sent[0].message, /Kaunsa product/)
    assert.match(r.sent[0].message, /Sweatshirt/)
    assert.deepEqual(r.errors, [])
  }],
  ['unnamed black stock still cannot become a single-product guess', async () => {
    const r = await runCase({ realStockResolver: true, stockSnapshot: pluralStockSnapshot,
      buyerText: 'Black M available?', reply: 'Sweatshirt Black M available hai sir.' })
    assert.equal(r.sent.length, 1)
    assert.match(JSON.stringify(r.requests), /PRODUCT NOT NAMED/)
    assert.match(r.sent[0].message, /Kaunsa product/)
    assert.deepEqual(r.errors, [])
  }],
  ['plural sweatshirt preserves an owner handoff', async () => {
    const r = await runCase({ realStockResolver: true, stockSnapshot: pluralStockSnapshot,
      buyerText: 'Black sweatshirts order mein galat aaye', reply: '[DEFER]' })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.size, 1)
    assert.deepEqual(r.errors, [])
  }],
  ['checkout image preserves the coupon quantity conversation for vision', async () => {
    const history = [{ status: 'REPLIED', buyerMessage: 'Any coupon available?', aiReply: 'How many pieces are you ordering sir?', createdAt: new Date(Date.now() - 60000) }]
    const r = await runCase({ history, invoiceKind: 'NO', gateVerdict: 'SILENT', reply: '[DEFER]', incomingMessages: [
      { messageId: 'checkout-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/checkout.jpg' },
    ] })
    assert.equal(r.requests.length, 1)
    assert.match(JSON.stringify(r.requests[0]), /How many pieces are you ordering/)
    assert.ok(r.requests[0].messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image')))
    assert.equal(r.sent.length, 0)
    assert.equal(r.logs.some(log => log.deferReason === 'bill_document'), false)
    assert.ok(r.pending.get('buyer-test').messages[0].messageIds.includes('checkout-test'))
    assert.equal(r.pending.get('buyer-test').messages[0].logData.deferReason, 'claude_deferred')
    assert.deepEqual(r.errors, [])
  }],
  ['plain checkout help answers from vision without a dispatch acknowledgement', async () => {
    const r = await runCase({ invoiceKind: 'NO', reply: 'Click Pay Now to complete your order sir.', incomingMessages: [
      { messageId: 'checkout-help-test', messageType: 'image', messageText: 'How do I finish this order?', mediaUrl: 'https://media.invalid/checkout.jpg' },
    ] })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /Pay Now/)
    assert.doesNotMatch(r.sent[0].message, /dispatch/i)
    assert.equal(r.pending.size, 0)
    assert.equal(r.logs.some(log => log.deferReason === 'bill_document'), false)
    assert.deepEqual(r.errors, [])
  }],
  ['store receipt template skips welcome while appended buyer questions remain actionable', async () => {
    const template = "Hi! Thank you for messaging Example Apparel\nWe've received your message and will get back to you as soon as possible.Feel free to send us a screenshot, product name, or size you're looking for!"
    for (const firstContact of [false, true]) {
      const r = await runCase({ incomingText: template, firstContact })
      assert.equal(r.requests.length, 0)
      assert.equal(r.restraintRequests.length, 0)
      assert.equal(r.sent.length, 0)
      assert.equal(r.pending.size, 0)
      assert.equal(r.timerDelays.length, 0)
      assert.ok(r.logs.some(log => log.deferReason === 'automated_business_reply' && log.status === 'SKIPPED' && log.messageIds.includes('inbound-test')))
      assert.deepEqual(r.errors, [])
    }
    for (const incomingText of [template + '\nCan I order a sample?', 'Can I order a sample?\n' + template]) {
      const r = await runCase({ incomingText, reply: 'Yes sir, order a sample from the website.' })
      assert.equal(r.requests.length, 1)
      assert.equal(r.sent.length, 1)
      assert.ok(!r.logs.some(log => log.deferReason === 'automated_business_reply'))
      assert.deepEqual(r.errors, [])
    }
    const held = await runCase({ incomingText: template + '\nPlease refund my payment.', reply: '[DEFER]' })
    assert.equal(held.sent.length, 0)
    assert.equal(held.pending.size, 1)
    assert.deepEqual(held.errors, [])
  }],
  ['complete print-service greeting skips paid welcome for new and returning contacts', async () => {
    const template = 'Thank you Hello! Thank you for contacting Example Prints 👕 We specialize in custom T-shirt printing. Please share your design, quantity, and T-shirt size. Our team will reply shortly!"'
    for (const firstContact of [false, true]) {
      const r = await runCase({ incomingText: template, firstContact, flushWelcome: true })
      assert.equal(r.requests.length, 0)
      assert.equal(r.restraintRequests.length, 0)
      assert.equal(r.sent.length, 0)
      assert.equal(r.pending.size, 0)
      assert.equal(r.timerDelays.length, 0)
      assert.ok(r.logs.some(log => log.deferReason === 'automated_business_reply' && log.status === 'SKIPPED' && log.messageIds.includes('inbound-test')))
      assert.deepEqual(r.errors, [])
    }
    for (const incomingText of [template + '\nCan I order a sample?', 'Can I order a sample?\n' + template]) {
      const r = await runCase({ incomingText, reply: 'Yes sir, order a sample from the website.' })
      assert.equal(r.requests.length, 1)
      assert.equal(r.sent.length, 1)
      assert.ok(!r.logs.some(log => log.deferReason === 'automated_business_reply'))
      assert.deepEqual(r.errors, [])
    }
    const held = await runCase({ incomingText: template + '\nPlease refund my payment.', reply: '[DEFER]' })
    assert.equal(held.sent.length, 0)
    assert.equal(held.pending.size, 1)
    assert.deepEqual(held.errors, [])
    const media = await runCase({ incomingMessages: [
      { messageId: 'greeting-test', messageType: 'text', messageText: template },
      { messageId: 'photo-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/photo.jpg' },
    ], invoiceKind: 'NO', reply: '[DEFER]' })
    assert.equal(media.requests.length, 1)
    assert.equal(media.pending.size, 1)
    assert.ok(!media.logs.some(log => log.deferReason === 'automated_business_reply'))
    assert.deepEqual(media.errors, [])
    const cooldown = await runCase({ incomingText: template + '\nCan I order a sample?', cooldown: true })
    assert.ok(cooldown.logs.some(log => log.deferReason === 'cooldown'))
    assert.ok(!cooldown.logs.some(log => log.deferReason === 'automated_business_reply'))
    assert.equal(cooldown.requests.length, 0)
    assert.deepEqual(cooldown.errors, [])
  }],
  ['English request after a Hindi honorific keeps the English answer path', async () => {
    const buyerText = 'Hello bhaiya I need shirts sent by train. Which option should I choose?'
    const reply = 'Train option select kar lijiye sir 👉 https://example.invalid/order'
    const rewriteReply = 'Please select the train option sir 👉 https://example.invalid/order'
    const r = await runCase({ buyerText, reply, rewriteReply })
    assert.equal(r.requests.length, 1)
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, rewriteReply)
    assert.deepEqual(r.errors, [])
    for (const extra of [{ buyerText: 'Hello bhaiya shirts chahiye, train se bhejo' }, { preferredLanguage: 'hindi' }]) {
      const control = await runCase({ buyerText, reply, rewriteReply, ...extra })
      assert.equal(control.rewriteRequests.length, 0)
      assert.equal(control.sent[0].message, reply)
      assert.deepEqual(control.errors, [])
    }
    const held = await runCase({ buyerText, reply: '[DEFER]' })
    assert.equal(held.sent.length, 0)
    assert.equal(held.pending.size, 1)
    const cooldown = await runCase({ incomingText: buyerText, cooldown: true })
    assert.equal(cooldown.requests.length, 0)
    assert.equal(cooldown.sent.length, 0)
  }],
  ['multiple GSM quotes preserve all requested products and unresolved fit', async () => {
    const catalogData = { categories: [{ products: [
      { name: 'Example Round Neck', slug: 'example-round-neck', gsm: 180, colors: ['Black'], sizes: ['M', 'XL'], rates: [{ colors: ['Black'], pricePerSize: { M: 111, XL: 121 }, samplePrice: 151 }] },
      { name: 'Oversize 180gsm', slug: 'oversize-180gsm', gsm: 180, colors: ['Black'], sizes: ['M'], rates: [{ colors: ['Black'], pricePerSize: { M: 131 }, samplePrice: 161 }] },
      { name: 'Oversize 210gsm', slug: 'oversize-210gsm', gsm: 210, colors: ['Black'], sizes: ['M'], rates: [{ colors: ['Black'], pricePerSize: { M: 141 }, samplePrice: 171 }] },
    ] }] }
    const buyerText = '180gsm and 210gsm wholesale price please', reply = '180gsm oversize ₹131, 210gsm ₹141 sir.'
    const r = await runCase({ buyerText, reply, catalogData })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /Example Round Neck: ₹111–₹121; Oversize 180gsm: ₹131/)
    assert.match(r.sent[0].message, /210gsm — Oversize 210gsm: ₹141/)
    assert.match(r.sent[0].message, /180gsm: Which product sir\?/)
    assert.match(r.sent[0].message, /bulk \(10\+ total pcs\)/)
    assert.deepEqual(r.errors, [])
    for (const extra of [{ imageUrl: 'https://media.invalid/product.jpg' }, { buyerText: buyerText + ' and fabric' }, { history: [{ status: 'REPLIED', buyerMessage: 'oversize only', aiReply: 'Ok sir', createdAt: new Date() }] }]) {
      const control = await runCase({ buyerText, reply, catalogData, ...extra })
      assert.equal(control.sent[0].message, reply)
      assert.deepEqual(control.errors, [])
    }
    const held = await runCase({ buyerText, reply: '[DEFER]', catalogData })
    assert.equal(held.sent.length, 0)
    assert.equal(held.pending.size, 1)
    const cooldown = await runCase({ incomingText: buyerText, cooldown: true, catalogData })
    assert.equal(cooldown.requests.length, 0)
    assert.equal(cooldown.sent.length, 0)
  }],
  ['text reaction placeholders skip first-contact paid followups and preserve source ids', async () => {
    for (const firstContact of [true, false]) {
      for (const text of ['[Reaction]', '  [reaction]  ']) {
        const r = await runCase({ firstContact, incomingText: text })
        assert.equal(r.requests.length, 0)
        assert.equal(r.restraintRequests.length, 0)
        assert.equal(r.rewriteRequests.length, 0)
        assert.equal(r.sent.length, 0)
        assert.equal(r.handled.length, 0)
        assert.equal(r.timerDelays.length, 0)
        assert.equal(r.logs.at(-1).deferReason, 'emoji_reaction')
        assert.ok(r.logs.at(-1).messageIds.includes('inbound-test'))
        assert.deepEqual(r.errors, [])
      }
    }
  }],
  ['typed and original reaction events retain their existing silent outcome', async () => {
    for (const message of [
      { messageType: 'reaction', messageText: '👍' },
      { messageType: 'text', messageText: '[Reacted: ❤️]' },
    ]) {
      const r = await runCase({ firstContact: true, incomingMessages: [{ messageId: 'reaction-test', ...message }] })
      assert.equal(r.logs.at(-1).deferReason, 'emoji_reaction')
      assert.equal(r.timerDelays.length, 0)
      assert.equal(r.sent.length, 0)
    }
  }],
  ['a reaction beside a buyer question still receives an answer', async () => {
    for (const incomingMessages of [
      [{ messageId: 'question-test', messageType: 'text', messageText: '[Reaction] How do I order?' }],
      [{ messageId: 'reaction-test', messageType: 'text', messageText: '[Reaction]' }, { messageId: 'question-test', messageType: 'text', messageText: 'How do I order?' }],
    ]) {
      const r = await runCase({ incomingMessages, reply: 'Please order on the website sir.' })
      assert.equal(r.requests.length, 1)
      assert.equal(r.sent.length, 1)
      assert.ok(!r.logs.some(row => row.deferReason === 'emoji_reaction'))
      assert.ok(r.logs.at(-1).messageIds.includes('question-test'))
      assert.deepEqual(r.errors, [])
    }
  }],
  ['a reaction marker cannot hide an accompanying image or document', async () => {
    for (const message of [
      { messageType: 'image', messageText: '[Reaction]', mediaUrl: 'https://media.invalid/photo.jpg' },
      { messageType: 'text', messageText: '[Reaction]', hasMedia: true },
      { messageType: 'text', messageText: '[Reaction]', mediaUrl: 'https://media.invalid/photo.jpg' },
      { messageType: 'document', messageText: '[Reaction]', mediaUrl: 'https://media.invalid/document.pdf' },
    ]) {
      const r = await runCase({ incomingMessages: [{ messageId: 'media-test', ...message }], reply: '[DEFER]', invoiceKind: 'NOT_INVOICE' })
      assert.ok(!r.logs.some(row => row.deferReason === 'emoji_reaction'))
    }
  }],
  ['reaction plus owner-only question preserves handoff and cooldown', async () => {
    for (const cooldown of [false, true]) {
      const r = await runCase({ incomingText: '[Reaction] Refund status?', cooldown, reply: '[DEFER]' })
      assert.equal(r.sent.length, 0)
      assert.ok(!r.logs.some(row => row.deferReason === 'emoji_reaction'))
      if (cooldown) assert.equal(r.logs.at(-1).deferReason, 'cooldown')
      else assert.equal(r.pending.size, 1)
    }
  }],

  ['catalogue shortcut keeps a Roman Hindi duration question in the answer flow', async () => {
    const r = await runCase({ incomingText: 'Kitane din me aayega aur catelog bhejo sir', keywordFilters: [{ name: 'catalog_request', matchType: 'partial', keywords: 'catelog', action: 'auto_reply', autoReplyText: 'catalog-only' }], reply: 'Usually 2-3 din sir. Catalogue: https://sale91.com/catalog' })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /2-3 din/)
    assert.equal(r.logs.some(row => row.deferReason === 'catalog_request'), false)
    assert.deepEqual(r.errors, [])
  }],
  ['catalogue shortcut keeps English and Hindi timing questions actionable', async () => {
    for (const text of ['Send catalog and how long does shipping take?', 'Catalog please, when will it arrive?', 'Delivery time and catalog please', 'कितने दिन में आएगा, catalog bhejo']) {
      const r = await runCase({ incomingText: text, keywordFilters: [{ name: 'catalog_request', matchType: 'partial', keywords: 'catalog', action: 'auto_reply', autoReplyText: 'catalog-only' }], reply: 'https://sale91.com/catalog [DEFER]' })
      assert.equal(r.requests.length, 1, text)
      assert.equal(r.logs.some(row => row.deferReason === 'catalog_request'), false, text)
      assert.equal(r.pending.size, 1, text)
    }
  }],
  ['plain catalogue and price-list requests retain their zero-cost shortcut', async () => {
    for (const text of ['Send catalog please', 'Color catelog chahiye', 'catalog with prices', 'catalog https://example.invalid/delivery-time']) {
      const r = await runCase({ incomingText: text, keywordFilters: [{ name: 'catalog_request', matchType: 'partial', keywords: 'catalog,catelog', action: 'auto_reply', autoReplyText: 'catalog-only' }] })
      assert.equal(r.requests.length, 0, text)
      assert.equal(r.sent[0].message, 'catalog-only', text)
    }
  }],
  ['catalogue timing bypass preserves manual cooldown', async () => {
    const r = await runCase({ incomingText: 'Send catalog and how many days for delivery?', cooldown: true, keywordFilters: [{ name: 'catalog_request', matchType: 'partial', keywords: 'catalog', action: 'auto_reply', autoReplyText: 'catalog-only' }] })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.equal(r.logs.at(-1).deferReason, 'cooldown')
  }],
  ['catalogue timing bypass does not disable other configured filters', async () => {
    const r = await runCase({ incomingText: 'Send catalog and how long for delivery?', keywordFilters: [{ name: 'owner_only', matchType: 'partial', keywords: 'delivery', action: 'defer' }, { name: 'catalog_request', matchType: 'partial', keywords: 'catalog', action: 'auto_reply', autoReplyText: 'catalog-only' }] })
    assert.equal(r.requests.length, 0)
    assert.equal(r.pending.size, 1)
  }],
  ['partial AI catalogue timing question respects disabled full replies', async () => {
    const r = await runCase({ incomingText: 'Kitane din me aayega aur catelog bhejo', active: false })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.equal(r.logs.some(row => row.deferReason === 'catalog_request'), false)
  }],
  ['completed shipment questions keep the model handoff and inbound evidence', async () => {
    for (const buyerText of ['Sir abhi bhej diya kya?', 'Aaj bhej dia?', 'Kal dispatch kar diya?', 'Abhi nikal gaya?', 'Aaj shipped?', 'Today already sent?']) {
      const r = await runCase({ buyerText, reply: '[DEFER]' })
      assert.equal(r.sent.length, 0, buyerText)
      const held = r.pending.get('buyer-test')?.messages[0]
      assert.ok(held, buyerText)
      assert.ok(held.messageIds.includes('inbound-test'))
      assert.ok(held.logData.costUsd > 0)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['future dispatch questions and instructions keep their established acknowledgement', async () => {
    for (const buyerText of ['Aaj dispatch hoga na?', 'Abhi bhej doge?', 'Kal nikal jayega?', 'Aaj nikalwa dena please']) {
      const r = await runCase({ buyerText, reply: '[DEFER]' })
      assert.equal(r.sent.length, 1, buyerText)
      assert.equal(r.pending.size, 0)
      assert.equal(r.logs.at(-1).deferReason, 'dispatch_ack_defer_override')
      assert.deepEqual(r.errors, [])
    }
  }],
  ['completed dispatch protection preserves an independently supported answer', async () => {
    const reply = 'Your parcel was dispatched today sir.'
    const r = await runCase({ buyerText: 'Today dispatched?', reply, history: [{ status: 'SKIPPED', deferReason: 'manual_reply', buyerMessage: 'old pairing', aiReply: 'Dispatched today', createdAt: new Date().toISOString() }] })
    assert.equal(r.sent[0].message, reply)
    assert.equal(r.pending.size, 0)
  }],
  ['compact colour-arrival question receives current stock before answering', async () => {
    const stockSnapshot = { fetchedAt: Date.now(), inStock: { 'Oversize 240gsm': { 'Off-white': { S: 1 } } }, oos: { 'Oversize 240gsm': { 'Off-white': 'S' } }, coming: {} }
    const r = await runCase({ buyerText: 'Bhai ofwhite aaya?', stockSnapshot, reply: 'Alert laga lijiye sir, stock aane par WhatsApp aa jayega 👉 https://www.bulkplaintshirt.com/delhi-stock.html?alert=1' })
    assert.match(r.requests[0].messages[0].content, /📦 LIVE STOCK DATA/)
    assert.match(r.sent[0].message, /alert=1/)
    assert.deepEqual(r.errors, [])
  }],
  ['stock-arrival fetch failure keeps the existing handoff', async () => {
    const r = await runCase({ buyerText: 'Bhai ofwhite aaya?', stockThrows: true, reply: '[DEFER]' })
    assert.doesNotMatch(r.requests[0].messages[0].content, /📦 LIVE STOCK DATA/)
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.size, 1)
    assert.ok(r.errors.some(x => x.includes('stock unavailable')))
  }],
  ['parcel arrival does not acquire inventory facts', async () => {
    const stockSnapshot = { fetchedAt: Date.now(), inStock: { 'Oversize 240gsm': { White: { S: 1 } } }, oos: {}, coming: {} }
    const r = await runCase({ buyerText: 'Mera white parcel aaya?', stockSnapshot, reply: '[DEFER]' })
    assert.doesNotMatch(r.requests[0].messages[0].content, /📦 LIVE STOCK DATA/)
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.size, 1)
  }],
  ['store menu skips model and welcome routing with its inbound id', async () => {
    const incomingText = '👋 Welcome to Example Clothing!\n👕 T-Shirts and custom prints\n🧥 Hoodies\n🏫 School Uniforms\n🎉 Festival & Event Wear\nBrowse our catalog and message us your requirements.\nExample Clothing — wear your style!'
    const r = await runCase({ incomingText })
    assert.equal(r.requests.length, 0)
    assert.equal(r.restraintRequests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.equal(r.logs.at(-1).deferReason, 'automated_business_reply')
    assert.ok(r.logs.at(-1).messageIds.includes('inbound-test'))
    assert.deepEqual(r.errors, [])
  }],
  ['a buying request after a store menu remains answerable', async () => {
    const incomingText = '👋 Welcome to Example Clothing!\n👕 T-Shirts and custom prints\n🧥 Hoodies\n🏫 School Uniforms\n🎉 Festival & Event Wear\nBrowse our catalog and message us your requirements.\nI need plain tees. How do I order?'
    const r = await runCase({ incomingText, reply: 'You can order from the website sir.' })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.ok(!r.logs.some(row => row.deferReason === 'automated_business_reply'))
    assert.deepEqual(r.errors, [])
  }],
  ['simple business acknowledgement keeps its existing skip', async () => {
    const r = await runCase({ incomingText: 'Thank you for contacting Example Clothing! Please let us know how we can help you.' })
    assert.equal(r.logs.at(-1).deferReason, 'automated_business_reply')
    assert.equal(r.sent.length, 0)
    assert.equal(r.requests.length, 0)
  }],
  ['generic regular-fit blue contradiction is repaired before delivery', async () => {
    const r = await runCase({ catalogData: blueCatalog, buyerText: '180gsm regular fit blue ka rate?', reply: '180gsm regular fit mein blue nahi hai sir — True Bio mein Navy, Royal Blue, Sky hai, ₹158. Kitne pieces chahiye?' })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /^Haan sir, True Bio 180gsm regular fit mein Navy, Royal Blue, Sky aate hain\./)
    assert.match(r.sent[0].message, /₹158\. Kitne pieces chahiye\?$/)
    assert.doesNotMatch(r.sent[0].message, /blue nahi hai/)
    assert.match(JSON.stringify(r.requests[0].messages), /REGULAR-FIT BLUE REQUEST/)
    assert.deepEqual(r.errors, [])
  }],
  ['English blue correction preserves the remaining answer', async () => {
    const r = await runCase({ catalogData: blueCatalog, preferredLanguage: 'English', buyerText: 'Is blue available in 180gsm regular fit?', reply: '180gsm regular fit blue is not available — Please select a size.' })
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0].message, 'Yes sir, True Bio is 180gsm regular fit and comes in Navy, Royal Blue, Sky. Please select a size.')
    assert.deepEqual(r.errors, [])
  }],
  ['blue correction leaves exact shades and other fits untouched', async () => {
    for (const buyerText of ['180gsm regular fit exact blue chahiye', '180gsm oversize blue chahiye']) {
      const reply = '180gsm regular fit mein blue nahi hai sir — HD photos check kar lijiye.'
      const r = await runCase({ catalogData: blueCatalog, buyerText, reply })
      assert.equal(r.sent.length, 1)
      assert.equal(r.sent[0].message, reply)
      assert.doesNotMatch(JSON.stringify(r.requests[0].messages), /REGULAR-FIT BLUE REQUEST/)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['blue correction retains a genuine size-stock qualification', async () => {
    const reply = 'True Bio Navy S abhi out of stock hai sir.'
    const r = await runCase({ catalogData: blueCatalog, buyerText: '180gsm regular fit blue S hai?', reply })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /^True Bio Navy S abhi out of stock hai sir\./)
    assert.doesNotMatch(r.sent[0].message, /Haan sir|Yes sir/)
    assert.deepEqual(r.errors, [])
  }],
  ['blue correction requires a verified current catalogue source', async () => {
    const reply = '180gsm regular fit mein blue nahi hai sir — HD photos check kar lijiye.'
    const r = await runCase({ buyerText: '180gsm regular fit blue hai?', reply })
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0].message, reply)
    assert.doesNotMatch(JSON.stringify(r.requests[0].messages), /REGULAR-FIT BLUE REQUEST/)
    assert.deepEqual(r.errors, [])
  }],
  ['blue correction preserves current-stock questions, exclusions and attached shade photos', async () => {
    for (const context of [
      { buyerText: '180gsm regular fit blue stock mein hai?' },
      { buyerText: '180gsm regular fit blue, not True Bio' },
      { buyerText: '180gsm regular fit blue chahiye', imageUrl: 'https://media.invalid/shade.jpg' },
    ]) {
      const reply = '180gsm regular fit mein blue nahi hai sir.'
      const r = await runCase({ catalogData: blueCatalog, ...context, reply })
      assert.equal(r.sent.length, 1)
      assert.equal(r.sent[0].message, reply)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['product restock answer survives the delivery guard in the send flow', async () => {
    const reply = '210gsm Black S ~6 din mein aa jayega sir'
    const r = await runCase({ buyerText: '210 gsm mein S aur XL kab tak aayenge?', reply })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0].message, reply)
    assert.deepEqual(r.errors, [])
  }],
  ['explicit product courier answer still gets corrected in the send flow', async () => {
    const r = await runCase({ buyerText: '210gsm S courier se kab tak aayega?', reply: '5 din mein mil jayega sir' })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /Usually 2-3 din/)
    assert.match(r.sent[0].message, /ETD/)
    assert.deepEqual(r.errors, [])
  }],
  ['Hindi courier duration repairs unsupported days through the send path', async () => {
    const r = await runCase({ buyerText: 'मैं जयपुर से हूँ। डिलिवर में मैक्सिमम टाम कितना लगाओगे?', reply: '4-5 din mein mil jaata hai sir' })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /2-3 din/)
    assert.match(r.sent[0].message, /ETD/)
    assert.doesNotMatch(r.sent[0].message, /4-5/)
    assert.deepEqual(r.errors, [])
  }],
  ['Hindi courier guard preserves air sample and owner handoff paths', async () => {
    const r = await runCase({ buyerText: 'एयर से सैंपल की डिलीवरी में कितना समय लगता है?', reply: 'AIR sample 1-2 din mein sir' })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /1-2 din/)
    const deferred = await runCase({ buyerText: 'डिलीवरी में कितना समय और मेरा रिफंड कब?', reply: '[DEFER]' })
    assert.equal(deferred.sent.length, 0)
    assert.equal(deferred.pending.size, 1)
    assert.deepEqual([...r.errors, ...deferred.errors], [])
  }],
  ['recipient receipt question remains actionable after an older manual answer', async () => {
    const owner = { status: 'SKIPPED', deferReason: 'manual_reply', buyerMessage: 'mispaired text', aiReply: 'Okay', createdAt: new Date(Date.now() - 8 * 3600000).toISOString() }
    const r = await runCase({ buyerText: 'Bhai parcel mila aapko', history: [owner], outboundHistory: [owner], gateVerdict: 'SILENT', reply: '[DEFER]' })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 0)
    assert.equal(r.handled.length, 0)
    assert.equal(r.pending.get('buyer-test').messages[0].logData.deferReason, 'claude_deferred')
    assert.deepEqual(r.errors, [])
  }],
  ['recipient receipt question preserves cooldown and daily reply cap', async () => {
    const cooling = await runCase({ incomingText: 'Bhai parcel mila aapko', cooldown: true, gateVerdict: 'SILENT' })
    assert.equal(cooling.requests.length, 0)
    assert.equal(cooling.logs.at(-1).status, 'COOLDOWN')
    assert.equal(cooling.sent.length, 0)
    assert.equal(cooling.pending.size, 0)
    const capped = await runCase({ buyerText: 'Bhai parcel mila aapko', repliesToday: 40, gateVerdict: 'SILENT' })
    assert.equal(capped.requests.length, 0)
    assert.equal(capped.logs.at(-1).deferReason, 'daily_reply_cap')
    assert.equal(capped.sent.length, 0)
    assert.equal(capped.pending.size, 0)
    assert.deepEqual([...cooling.errors, ...capped.errors], [])
  }],
  ['buyer receipt acknowledgements retain silence in owner-handled threads', async () => {
    const owner = { status: 'SKIPPED', deferReason: 'manual_reply', aiReply: 'Okay', createdAt: new Date(Date.now() - 3600000).toISOString() }
    for (const buyerText of ['Mujhe tshirt mil gayi sir', 'I received my parcel thanks']) {
      const r = await runCase({ buyerText, history: [owner], outboundHistory: [owner], gateVerdict: 'SILENT' })
      assert.equal(r.requests.length, 0)
      assert.equal(r.sent.length, 0)
      assert.equal(r.pending.size, 0)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['tracking images hand off before dispatch and model output in both modes', async () => {
    for (const active of [true, false]) {
      for (const messageText of ['[Image]', 'Order placed, dispatch please']) {
        const r = await runCase({ active, invoiceKind: 'TRACKING', incomingMessages: [
          { messageId: 'tracking-test', messageType: 'image', messageText, mediaUrl: 'https://media.invalid/tracking.jpg' },
        ] })
        assert.equal(r.sent.length, 0)
        assert.equal(r.requests.length, 0)
        assert.equal(r.handled.length, 0)
        const pending = r.pending.get('buyer-test')
        assert.equal(pending.messages[0].logData.deferReason, 'tracking_image')
        assert.equal(pending.messages[0].logData.status, 'DEFERRED')
        assert.ok(pending.messages[0].messageIds.includes('tracking-test'))
        assert.deepEqual(r.errors, [])
      }
    }
  }],
  ['fresh payment receipts still dispatch in both modes', async () => {
    for (const active of [true, false]) {
      const r = await runCase({ active, invoiceKind: 'FRESH', incomingMessages: [
        { messageId: 'receipt-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/receipt.jpg' },
      ] })
      assert.equal(r.sent.length, 1)
      assert.match(r.sent[0].message, /dispatching ASAP/)
      assert.equal(r.logs.at(-1).deferReason, 'bill_document')
      assert.equal(r.pending.size, 0)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['tracking image routing preserves manual cooldown in both modes', async () => {
    for (const active of [true, false]) {
      const r = await runCase({ active, cooldown: true, invoiceKind: 'TRACKING', incomingMessages: [
        { messageId: 'tracking-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/tracking.jpg' },
      ] })
      assert.equal(r.sent.length, 0)
      assert.equal(r.pending.size, 0)
      assert.equal(r.logs.at(-1).status, 'COOLDOWN')
      assert.deepEqual(r.errors, [])
    }
  }],
  ['obsolete imported launch denial is removed before the paid prompt', async () => {
    const obsolete = { source: 'CORRECTION', similarity: 0.9, title: 'Old launch answer', content: 'Buyer: When is the ladies tee launch?\nCorrect reply: Ladies tees will not launch.', metadata: { backfilled: true } }
    const useful = { source: 'CORRECTION', similarity: 0.8, title: 'Care advice', content: 'Buyer: How to wash this tee?\nCorrect reply: Hand wash gently.', metadata: { backfilled: true } }
    const r = await runCase({ buyerText: 'When is the ladies tee launch?', knowledge: [obsolete, useful], reply: 'The women range has not launched yet sir.' })
    assert.equal(r.requests.length, 1)
    const prompt = JSON.stringify(r.requests[0])
    assert.doesNotMatch(prompt, /Ladies tees will not launch/)
    assert.match(prompt, /Hand wash gently/)
    assert.equal(r.sent.length, 1)
    assert.deepEqual(r.errors, [])
  }],
  ['current owner cancellation and different garment corrections remain available', async () => {
    const knowledge = [
      { source: 'CORRECTION', similarity: 0.9, title: 'Current owner decision', content: 'Buyer: When is the ladies tee launch?\nCorrect reply: Ladies tees will not launch.', metadata: { backfilled: false } },
      { source: 'CORRECTION', similarity: 0.8, title: 'Different garment', content: 'Buyer: When is the girls crop tee launch?\nCorrect reply: Girls tees will not launch.', metadata: { backfilled: true } },
    ]
    const r = await runCase({ buyerText: 'Which new garments are planned?', knowledge, reply: 'Let me check sir.' })
    const prompt = JSON.stringify(r.requests[0])
    assert.match(prompt, /Current owner decision/)
    assert.match(prompt, /Different garment/)
    assert.equal(r.sent.length, 1)
    assert.deepEqual(r.errors, [])
  }],
  ['stock-alert repeat handling preserves an independent fabric answer', async () => {
    const reply = 'Navy S is out of stock. It is 100% cotton sir.'
    const r = await runCase({ buyerText: '240 navy S restock kab hoga, cotton hai?', reply, history: [{ buyerMessage: '240 navy S kab milega?', aiReply: 'Alert laga lijiye sir, stock aane par WhatsApp aa jayega https://www.bulkplaintshirt.com/delhi-stock.html?alert=1', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.pending.size, 0)
    assert.equal(r.sent[0].message, reply)
    assert.equal(r.logs.at(-1).aiReply, reply)
    assert.deepEqual(r.errors, [])
  }],

  ['out-of-stock timing includes a compact WhatsApp alert offer', async () => {
    const r = await runCase({ whatsappNumber: '919999999999', buyerText: '240 navy S,M kabtak milega?', reply: 'Navy S aur M abhi out of stock hai sir, koi shipment nahi hai filhaal — Coming Soon tab check karte rahiye 👉 https://www.bulkplaintshirt.com/delhi-stock.html' })
    assert.equal(r.pending.size, 0)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /alert/i)
    assert.match(r.sent[0].message, /WhatsApp/i)
    assert.match(r.sent[0].message, /alert=1&ph=9999999999/)
    assert.doesNotMatch(r.sent[0].message, /Coming Soon/i)
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
    assert.deepEqual(r.errors, [])
  }],
  ['week follow-up after old pointer gets first alert without an invented ETA', async () => {
    const r = await runCase({ whatsappNumber: '919999999999', buyerText: '1 week ke andar milega?', reply: 'Navy S,M ka koi shipment nahi hai abhi sir, date nahi de sakta — Coming Soon tab check karte rahiye 🙏', history: [{ buyerMessage: '240 navy S,M kabtak milega?', aiReply: 'Navy S aur M abhi out of stock hai sir, koi shipment nahi hai filhaal — Coming Soon tab check karte rahiye 👉 https://www.bulkplaintshirt.com/delhi-stock.html', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.pending.size, 0)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /alert=1&ph=9999999999/)
    assert.match(r.sent[0].message, /WhatsApp/i)
    assert.doesNotMatch(r.sent[0].message, /1 week|7 din|Coming Soon/i)
    assert.deepEqual(r.errors, [])
  }],
  ['repeated unknown timing after an alert remains an owner handoff', async () => {
    const r = await runCase({ buyerText: '240 navy S,M kab tak aa jayega?', reply: 'Navy S,M ka koi shipment nahi hai sir, Coming Soon tab check karte rahiye.', history: [{ buyerMessage: '240 navy S,M kabtak milega?', aiReply: 'Navy S,M ki date nahi hai sir, alert laga lijiye — stock aane par WhatsApp aa jayega https://www.bulkplaintshirt.com/delhi-stock.html?alert=1', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.get('buyer-test')?.messages[0].logData.deferReason, 'restock_pointer_handoff')
    assert.deepEqual(r.errors, [])
  }],

  ['printer fulfilment question reaches the answer despite a silent gate', async () => {
    const history = [{ buyerMessage: 'Can I get my logo added?', aiReply: 'For printing, contact the printer https://wa.me/910000000000', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }]
    const r = await runCase({ buyerText: 'Can he print them and ship directly to us', reply: 'Please confirm printing and shipping with the printer sir.', gateVerdict: 'SILENT', history })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.equal(r.handled.length, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['printer follow-up preserves acknowledgement and stale referral silence', async () => {
    for (const [buyerText, age] of [['Okay I will talk to him', 60000], ['Can he print them and ship directly to us', 7200001]]) {
      const history = [{ aiReply: 'For printing, contact the printer https://wa.me/910000000000', status: 'REPLIED', createdAt: new Date(Date.now() - age) }]
      const r = await runCase({ buyerText, gateVerdict: 'SILENT', history })
      assert.equal(r.requests.length, 0)
      assert.equal(r.sent.length, 0)
    }
  }],
  ['printer follow-up preserves manual ownership and daily cap', async () => {
    const history = [{ aiReply: 'For printing, contact the printer https://wa.me/910000000000', status: 'REPLIED', createdAt: new Date(Date.now() - 900000) }]
    for (const boundary of [{ outboundHistory: [{ status: 'SKIPPED', deferReason: 'manual_reply', createdAt: new Date(Date.now() - 700000) }] }, { repliesToday: 25 }]) {
      const r = await runCase({ buyerText: 'Can he print them and ship directly to us', gateVerdict: 'SILENT', history, ...boundary })
      assert.equal(r.requests.length, 0)
      assert.equal(r.sent.length, 0)
    }
  }],
  ['printer follow-up preserves manual cooldown', async () => {
    const r = await runCase({ incomingText: 'Can he print them and ship directly to us', cooldown: true, gateVerdict: 'SILENT', history: [{ aiReply: 'For printing, contact the printer https://wa.me/910000000000', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
  }],
  ['game earning clarification reaches the answer despite a silent gate', async () => {
    const r = await runCase({ buyerText: 'Could I make money from this game', reply: 'No sir, just for play purpose.', gateVerdict: 'SILENT', history: [{ buyerMessage: 'What is the website game for?', aiReply: 'Just for play purpose sir.', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent[0]?.message, 'No sir, just for play purpose.')
    assert.equal(r.handled.length, 0)
    assert.equal(r.logs.at(-1).status, 'REPLIED')
    assert.deepEqual(r.errors, [])
  }],
  ['game follow-up does not override an owner handling the thread', async () => {
    const r = await runCase({ buyerText: 'Could I make money from this game', gateVerdict: 'SILENT', history: [{ buyerMessage: 'What is the website game for?', aiReply: 'Just for play purpose sir.', status: 'REPLIED', createdAt: new Date(Date.now() - 900000) }], outboundHistory: [{ status: 'SKIPPED', deferReason: 'manual_reply', createdAt: new Date(Date.now() - 700000) }] })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['game follow-up preserves the per-buyer daily limit', async () => {
    const r = await runCase({ buyerText: 'Could I make money from this game', repliesToday: 25, gateVerdict: 'SILENT', history: [{ buyerMessage: 'What is the website game for?', aiReply: 'Just for play purpose sir.', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['game acknowledgement retains silence', async () => {
    const r = await runCase({ buyerText: 'Okay sir', gateVerdict: 'SILENT', history: [{ buyerMessage: 'What is the website game for?', aiReply: 'Just for play purpose sir.', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['unrelated earnings topic is left to existing triage', async () => {
    const r = await runCase({ buyerText: 'Could I make money through referrals', gateVerdict: 'SILENT', history: [{ buyerMessage: 'What is the website game for?', aiReply: 'Just for play purpose sir.', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['game follow-up preserves manual cooldown', async () => {
    const r = await runCase({ incomingText: 'Could I make money from this game?', cooldown: true, history: [{ buyerMessage: 'What is the website game for?', aiReply: 'Just for play purpose sir.', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['no-date stock repetition stays visible as an owner handoff', async () => {
    const r = await runCase({ buyerText: 'Isme toh acid wash nahi hai', reply: 'Acid wash uss page pe abhi list nahi hai sir, Black M ka koi shipment nahi hai, jo available hai wo le lijiye.', history: [{ buyerMessage: 'Restock kab hoga?', aiReply: 'Acid wash Black M ka koi shipment nahi hai, alert laga lijiye https://www.bulkplaintshirt.com/delhi-stock.html?alert=1', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.sent.length, 0)
    assert.equal(r.handled.length, 0)
    const held = r.pending.get('buyer-test')?.messages[0]
    assert.ok(held)
    assert.equal(held.logData.deferReason, 'restock_pointer_handoff')
    assert.deepEqual(Array.from(held.messageIds), ['inbound-test'])
    assert.deepEqual(r.errors, [])
  }],
  ['restock procurement continuation cannot send another no-date echo', async () => {
    const r = await runCase({ buyerText: 'Abhi mangwa sakte hai kya?', reply: 'Abhi nahi bata sakta sir, acid wash Black M ka koi shipment nahi hai.', history: [{ buyerMessage: 'Isme acid wash nahi hai', aiReply: 'Acid wash Black M ka koi shipment nahi hai, alert laga lijiye https://www.bulkplaintshirt.com/delhi-stock.html?alert=1', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.get('buyer-test')?.messages[0].logData.deferReason, 'restock_pointer_handoff')
    assert.deepEqual(r.errors, [])
  }],
  ['fresh stock alternative is still sent beside a no-date answer', async () => {
    const reply = 'Black M acid wash ka koi shipment nahi hai, Black XL available hai sir.'
    const r = await runCase({ buyerText: 'Acid wash kab restock hoga?', reply, history: [{ buyerMessage: 'Black M acid wash kab aayega?', aiReply: 'Check Coming Soon sir.', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.ok(r.sent[0].message.startsWith(reply))
    assert.match(r.sent[0].message, /alert=1/)
    assert.equal(r.pending.size, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['old Notification shortcut without a protocol is repaired before send', async () => {
    const r = await runCase({ whatsappNumber: '919999999999', buyerText: 'Stock aane par notify karna', reply: 'Stock Alert ko enable kar lo - sale91.com/?stockalert=1' })
    assert.equal(r.sent[0].message, 'Stock Alert ko enable kar lo - https://www.bulkplaintshirt.com/delhi-stock.html?alert=1&ph=9999999999')
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
    assert.deepEqual(r.errors, [])
  }],
  ['stock alert removes a different buyer phone carried by the model', async () => {
    const r = await runCase({ whatsappNumber: '919999999999', buyerText: 'Stock alert please', reply: 'Set a stock alert https://www.bulkplaintshirt.com/delhi-stock.html?alert=1&ph=8888888888' })
    assert.match(r.sent[0].message, /[&]ph=9999999999$/)
    assert.doesNotMatch(r.sent[0].message, /8888888888/)
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
    assert.deepEqual(r.errors, [])
  }],
  ['stock alert keeps unknown phone blank instead of borrowing a historical phone', async () => {
    const r = await runCase({ buyerText: 'Stock alert please', reply: 'Set a stock alert https://www.bulkplaintshirt.com/delhi-stock.html?alert=1&ph=8888888888' })
    assert.equal(r.sent[0].message, 'Set a stock alert https://www.bulkplaintshirt.com/delhi-stock.html?alert=1')
    assert.deepEqual(r.errors, [])
  }],
  ['stock page links consistently use the upgraded destination', async () => {
    for (const reply of ['Live stock yahan hai sir https://www.bulkplaintshirt.com/delhi-stock.html', 'Coming Soon tab check kar lijiye https://www.bulkplaintshirt.com/delhi-stock.html']) {
      const r = await runCase({ buyerText: 'Live stock kahan dekhu?', reply })
      assert.equal(r.sent[0].message, reply.replace('delhi-stock.html', 'delhi-stock.html?alert=1'))
      assert.deepEqual(r.errors, [])
    }
  }],
  ['stock alert survives language repair with the current buyer phone', async () => {
    const fixed = 'Set a stock alert here sir https://www.bulkplaintshirt.com/delhi-stock.html?alert=1&ph=9999999999'
    const r = await runCase({ whatsappNumber: '919999999999', buyerText: 'Please notify me when stock returns', reply: 'Stock alert laga lijiye sir https://sale91.com/?stockalert=1', rewriteReply: fixed })
    assert.equal(r.sent[0].message, fixed)
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.logs.at(-1).aiReply, fixed)
    assert.deepEqual(r.errors, [])
  }],
  ['stock alert preserves partial handoff and owner cooldown', async () => {
    const r = await runCase({ buyerText: 'Stock alert laga do aur mera refund check karna', reply: 'Stock alert yahan laga lijiye https://sale91.com/?stockalert=1\n[DEFER]' })
    assert.match(r.sent[0].message, /delhi-stock\.html\?alert=1/)
    assert.equal(r.pending.size, 1)
    assert.deepEqual(r.errors, [])
    const held = await runCase({ buyerText: 'Stock alert laga do', reply: 'Stock alert https://sale91.com/?stockalert=1', cooldown: true })
    assert.equal(held.sent.length, 0)
    assert.equal(held.logs.at(-1).deferReason, 'superseded_by_intervention')
  }],
  ['stock notification uses the WhatsApp form and current buyer number before send and log', async () => {
    const r = await runCase({ whatsappNumber: '919999999999', buyerText: 'Kal ek bar update kar dena aap', reply: 'Ji sir, stock alert laga lijiye 👉 https://sale91.com/?stockalert=1' })
    assert.equal(r.sent[0].message, 'Ji sir, stock alert laga lijiye 👉 https://www.bulkplaintshirt.com/delhi-stock.html?alert=1&ph=9999999999')
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
    assert.deepEqual(r.errors, [])
  }],
  ['generic biowash quote keeps live size bands through send and logging', async () => {
    const catalogData = { categories: [{ products: [{ name: 'Biowash Round Neck', slug: 'biowash-round-neck', gsm: 180, colors: ['Black'], sizes: ['38', '46'], rates: [{ colors: ['Black'], pricePerSize: { 38: 111, 46: 121 }, samplePrice: 151 }] }] }] }
    const r = await runCase({ buyerText: 'Bhai biowash ka price kya hai?', reply: 'Bio Rneck ₹111 hai bhai (10+ pcs pe)', catalogData })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /₹111–₹121 bulk \(10\+ total pcs/)
    assert.match(r.sent[0].message, /colour\/size ke hisaab se/)
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
    assert.deepEqual(r.errors, [])
  }],
  ['selected biowash size and owner handoff keep their scope', async () => {
    const catalogData = { categories: [{ products: [{ name: 'Biowash Round Neck', slug: 'biowash-round-neck', gsm: 180, colors: ['Black'], sizes: ['38', '46'], rates: [{ colors: ['Black'], pricePerSize: { 38: 111, 46: 121 }, samplePrice: 151 }] }] }] }
    const reply = 'Bio Rneck size 46 ₹121 bulk sir'
    const r = await runCase({ buyerText: 'Bio wash 46 rate?', reply, catalogData })
    assert.equal(r.sent[0].message, reply)
    assert.deepEqual(r.errors, [])
    const deferred = await runCase({ buyerText: 'Biowash price and refund problem', reply: '[DEFER]', catalogData })
    assert.equal(deferred.sent.length, 0)
    assert.equal(deferred.pending.size, 1)
    assert.deepEqual(deferred.errors, [])
  }],
  ['app discovery wording distinguishes store listing before send', async () => {
    const r = await runCase({ buyerText: 'App Store mein aapka app nahi mil raha', reply: 'App nahi hai sir — website ko install kar lijiye https://sale91.com', gateVerdict: 'SILENT' })
    assert.equal(r.sent[0].message, 'Store par listing nahi hai sir — website ko install kar lijiye https://sale91.com')
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
    assert.deepEqual(r.errors, [])
  }],
  ['store lookup trouble reaches the reply policy despite a silent gate', async () => {
    const reply = 'Website hi app ki tarah install ho jaati hai sir 👉 https://sale91.com'
    const r = await runCase({ incomingText: 'App Store mein aapka app nahi mil raha', gateVerdict: 'SILENT', reply })
    assert.equal(r.restraintRequests.length, 0)
    assert.equal(r.requests.length, 1)
    assert.equal(r.sent[0].message, reply)
    assert.equal(r.logs.at(-1).status, 'REPLIED')
    assert.deepEqual(r.errors, [])
  }],
  ['successful app discovery acknowledgement can stay silent', async () => {
    const r = await runCase({ buyerText: 'Found the app in the App Store, thanks', gateVerdict: 'SILENT' })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.equal(r.logs.at(-1).deferReason, 'ai_chose_silence')
  }],
  ['store lookup trouble keeps mixed payment issues under owner triage', async () => {
    const r = await runCase({ incomingText: "Cannot find the app on Play Store and my payment is missing", gateVerdict: 'SILENT', reply: '[DEFER]' })
    assert.equal(r.requests.length, 1)
    assert.equal(r.pending.size, 1)
    assert.equal(r.sent.length, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['store lookup trouble preserves owner cooldown and daily cap', async () => {
    const text = 'App Store mein aapka app nahi mil raha'
    const cooldown = await runCase({ incomingText: text, cooldown: true, gateVerdict: 'SILENT' })
    assert.equal(cooldown.requests.length, 0)
    assert.equal(cooldown.sent.length, 0)
    assert.equal(cooldown.logs.at(-1).deferReason, 'cooldown')
    const capped = await runCase({ buyerText: text, repliesToday: 25, gateVerdict: 'SILENT' })
    assert.equal(capped.requests.length, 0)
    assert.equal(capped.sent.length, 0)
    assert.equal(capped.logs.at(-1).deferReason, 'daily_reply_cap')
  }],
  ['bulk discount keeps a mixed product answer through send and logging', async () => {
    const reply = 'Kids sizes are in the catalog. We sell blanks; ask the printer about the front print.'
    const r = await runCase({ buyerText: 'Need 600 pcs kids and 1200 pcs adult with front print. Please quote the best price.', reply })
    assert.equal(r.sent.length, 1)
    assert.ok(r.sent[0].message.startsWith(reply))
    assert.match(r.sent[0].message, /1000\+ pcs in one order/)
    assert.match(r.sent[0].message, /₹4\/pc/)
    assert.equal(r.logs.find(row => row.status === 'REPLIED').aiReply, r.sent[0].message)
    assert.deepEqual(r.errors, [])
  }],
  ['question-marked completion checks reach triage without clearing Waiting', async () => {
    for (const incomingText of ['Done?', 'done ???', 'done？', 'done؟']) {
      const r = await runCase({ incomingText, gateVerdict: 'SILENT', reply: '[DEFER]', history: [{ buyerMessage: 'I will arrange collection when it is packed', aiReply: 'We will pack it and let you know', status: 'REPLIED', createdAt: new Date(Date.now() - 45 * 60000).toISOString() }] })
      assert.equal(r.requests.length, 1)
      assert.equal(r.pending.size, 1)
      assert.equal(r.handled.length, 0)
      assert.equal(r.sent.length, 0)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['stored acknowledgement keywords cannot silence a completion question', async () => {
    const r = await runCase({ incomingText: 'Done?', keywordFilters: [{ name: 'acknowledgment', action: 'skip', matchType: 'exact', keywords: 'done,okay' }], gateVerdict: 'SILENT', reply: '[DEFER]' })
    assert.equal(r.requests.length, 1)
    assert.equal(r.pending.size, 1)
    assert.equal(r.handled.length, 0)
    assert.deepEqual(r.errors, [])
  }],
  ['plain completion acknowledgements still close without a model call', async () => {
    for (const incomingText of ['done', 'Okay done 👍', 'theek hai']) {
      const r = await runCase({ incomingText })
      assert.equal(r.requests.length, 0)
      assert.equal(r.handled.length, 1)
      assert.equal(r.pending.size, 0)
      assert.equal(r.logs[0].deferReason, 'conversation_ender_deterministic')
    }
  }],
  ['completion questions during owner cooldown remain visible and silent', async () => {
    const r = await runCase({ incomingText: 'Done?', cooldown: true })
    assert.equal(r.requests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.equal(r.handled.length, 0)
    assert.equal(r.logs[0].status, 'COOLDOWN')
    assert.equal(r.logs[0].deferReason, 'cooldown')
  }],
  ['timing context excludes another colour and unresolved product scopes', async () => {
    const date = new Date(Date.now() + 19800000).toISOString().slice(0, 10)
    const timedFacts = [{ content: `[stated ${date}] Buyer asked: "Oversize 240gsm Red and Off-white restock?" — Ketu's answer: "8-9 days"` }]
    for (const [buyerText, prior] of [['Beige me bhi S size nahi he', 'Oversize 240gsm colours'], ['Off-white coming soon mein nahi hai', 'Oversize 210 and 240gsm Off-white S M stock nahi hai']]) {
      const r = await runCase({ buyerText, timedFacts, reply: '[DEFER]', history: [{ buyerMessage: prior, status: 'REPLIED', createdAt: new Date(Date.now() - 3600000).toISOString() }] })
      assert.equal(r.requests.length, 1)
      assert.match(r.requests[0].messages[0].content, /TIMING SCOPE/)
      assert.doesNotMatch(r.requests[0].messages[0].content, /Current timing estimate|8-9 days/)
      assert.equal(r.sent.length, 0)
      assert.equal(r.pending.size, 1)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['an unrelated address question receives no stock timing context', async () => {
    const date = new Date(Date.now() + 19800000).toISOString().slice(0, 10)
    const r = await runCase({ timedFacts: [{ content: `[stated ${date}] Buyer asked: "Oversize 240gsm Red restock?" — Ketu's answer: "8-9 days"` }] })
    assert.doesNotMatch(r.requests[0].messages[0].content, /Current timing estimate|8-9 days|TIMING SCOPE/)
    assert.equal(r.sent.length, 1)
  }],
  ['a readable order-details image reaches vision despite a silent text gate', async () => {
    const r = await runCase({ incomingMessages: [{ messageId: 'order-panel-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/order-panel.jpg' }], invoiceKind: 'NO', gateVerdict: 'SILENT', reply: 'Noted sir 🙏' })
    assert.equal(r.requests.length, 1)
    assert.ok(r.requests[0].messages[0].content.some(part => part.type === 'image'))
    assert.equal(r.restraintRequests.length, 0)
    assert.equal(r.sent[0].message, 'Noted sir 🙏')
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
    assert.deepEqual(Array.from(r.logs.at(-1).messageIds), ['order-panel-test'])
    assert.deepEqual(r.errors, [])
  }],
  ['cart and complaint images retain the vision answer or owner handoff', async () => {
    const reply = 'Complete checkout on the website sir 👉 https://sale91.com'
    const cart = await runCase({ incomingMessages: [{ messageId: 'cart-image-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/cart.jpg' }], invoiceKind: 'NO', gateVerdict: 'SILENT', reply })
    assert.equal(cart.sent[0].message, reply)
    assert.doesNotMatch(cart.sent[0].message, /dispatch|paid/i)
    const complaint = await runCase({ incomingMessages: [{ messageId: 'defect-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/defect.jpg' }], invoiceKind: 'NO', gateVerdict: 'SILENT', reply: '[DEFER]' })
    assert.equal(complaint.sent.length, 0)
    assert.equal(complaint.pending.size, 1)
    assert.equal(complaint.logs.some(row => row.deferReason === 'ai_chose_silence'), false)
  }],
  ['image processing keeps manual cooldown and the daily reply cap', async () => {
    const held = await runCase({ cooldown: true, incomingMessages: [{ messageId: 'cooldown-image-test', messageType: 'image', messageText: '[Image]', mediaUrl: 'https://media.invalid/order-panel.jpg' }], invoiceKind: 'NO' })
    assert.equal(held.sent.length, 0)
    assert.equal(held.requests.length, 0)
    assert.equal(held.logs.at(-1).status, 'COOLDOWN')
    const capped = await runCase({ imageUrl: 'https://media.invalid/order-panel.jpg', buyerText: '[Image]', repliesToday: 25 })
    assert.equal(capped.requests.length, 0)
    assert.equal(capped.logs.at(-1).deferReason, 'daily_reply_cap')
  }],
  ['missing image and text-only acknowledgement preserve their earlier paths', async () => {
    const missing = await runCase({ imageUrl: 'https://media.invalid/missing.jpg', mediaAvailable: false, buyerText: '', gateVerdict: 'SILENT' })
    assert.equal(missing.requests.length, 0)
    assert.equal(missing.pending.get('buyer-test').messages[0].logData.deferReason, 'media_deferred')
    const ack = await runCase({ buyerText: 'Ok thank you', gateVerdict: 'SILENT' })
    assert.equal(ack.sent.length, 0)
    assert.equal(ack.requests.length, 0)
    assert.equal(ack.logs.at(-1).deferReason, 'ai_chose_silence')
  }],
  ['generic hoodie summary sends the complete current size and colour range', async () => {
    const r = await runCase({ buyerText: 'Hello Hoodie price', reply: 'Hoodie 320gsm ₹211 (Black), baaki colours ₹239 sir.' })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /Hoodie 320gsm ₹211–₹251 bulk \(10\+ total pcs/)
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
    assert.deepEqual(r.errors, [])
  }],
  ['hoodie selected size, samples and owner cooldown keep their paths', async () => {
    for (const [buyerText, reply] of [['Black hoodie XXL price for 20 pcs', 'Black XXL ₹223 sir.'], ['Hoodie 2 samples price', 'Hoodie sample ₹277 sir.']]) {
      const r = await runCase({ buyerText, reply })
      assert.equal(r.sent[0].message, reply)
    }
    const held = await runCase({ cooldown: true, incomingText: 'Hoodie price' })
    assert.equal(held.requests.length, 0)
    assert.equal(held.sent.length, 0)
    assert.equal(held.logs.at(-1).status, 'COOLDOWN')
    const refund = await runCase({ buyerText: 'Hoodie refund', reply: '[DEFER]' })
    assert.equal(refund.sent.length, 0)
    assert.equal(refund.pending.size, 1)
  }],
  ['a hoodie colour clarification with no quoted rate stays intact', async () => {
    const reply = 'Hoodie catalog 👉 https://sale91.com/catalog/p/hoodie-320gsm Colour bataiye sir?'
    const r = await runCase({ buyerText: 'Hello Hoodie price', reply })
    assert.equal(r.sent[0].message, reply)
    assert.equal(r.pending.size, 0)
  }],
  ['first-time code request with known quantity queues the existing handoff', async () => {
    const r = await runCase({ buyerText: "Can you send a promo code? I'm joining as first time.", reply: 'Fixed price sir.', history: [{ buyerMessage: 'Black tees: 63 pcs', aiReply: 'Please order online.', status: 'REPLIED' }] })
    assert.equal(r.sent.length, 0)
    const held = r.pending.get('buyer-test')?.messages[0]
    assert.equal(held?.logData.deferReason, 'coupon_code_handoff')
    assert.deepEqual(Array.from(held.messageIds), ['inbound-test'])
    assert.ok(held.logData.costUsd > 0)
    assert.deepEqual(r.errors, [])
  }],
  ['first-time coupon context preserves quantity questions, code help and cooldown', async () => {
    const ask = await runCase({ buyerText: "Any coupon? I'm a first-time customer", reply: 'How many pieces in total sir?' })
    assert.equal(ask.sent[0].message, 'How many pieces in total sir?')
    assert.equal(ask.pending.size, 0)
    const help = await runCase({ buyerText: "Where do I enter my coupon code? I'm a new buyer", reply: 'Paste the full code at checkout sir.', history: [{ buyerMessage: '63 pcs', status: 'REPLIED' }] })
    assert.equal(help.sent[0].message, 'Paste the full code at checkout sir.')
    assert.equal(help.pending.size, 0)
    const cooldown = await runCase({ cooldown: true, incomingText: "Coupon for 63 pcs please. I'm joining as first time", reply: 'Fixed price sir.' })
    assert.equal(cooldown.sent.length, 0)
    assert.equal(cooldown.pending.size, 0)
    assert.equal(cooldown.logs.at(-1).status, 'COOLDOWN')
  }],
  ['unanswered product choice prevents a premature stock date in the sent reply', async () => {
    const history = [{ status: 'REPLIED', createdAt: new Date(Date.now() - 30000).toISOString(), buyerMessage: 'Black tshirt', aiReply: 'Black 180gsm ya 260gsm sir?' }]
    const r = await runCase({ buyerText: 'Stock kab aayega sir?', reply: '180gsm black 4-5 din mein aayega sir.', history })
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0].message, 'Black 180gsm ya 260gsm sir?')
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
    assert.deepEqual(r.errors, [])
  }],
  ['explicit product selection and mixed owner handoff keep their existing paths', async () => {
    const history = [{ status: 'REPLIED', createdAt: new Date(Date.now() - 30000).toISOString(), buyerMessage: 'Black tshirt', aiReply: 'Black 180gsm ya 260gsm sir?' }]
    const reply = '260gsm black ke liye Coming Soon tab check kar lijiye sir.'
    const selected = await runCase({ buyerText: '260gsm stock kab aayega?', reply, history })
    assert.match(selected.sent[0].message, /260gsm black/i)
    assert.match(selected.sent[0].message, /alert=1/)
    const held = await runCase({ buyerText: 'Stock kab aayega aur mera refund?', reply: '[DEFER]', history })
    assert.equal(held.sent.length, 0)
    assert.equal(held.pending.size, 1)
  }],
  ['generic polo quote keeps both current size ranges in the sent reply', async () => {
    const catalogData = { categories: [{ products: [
      { name: 'Cotton Polo', slug: 'cotton-polo', gsm: 220, colors: ['Black'], sizes: ['36', '46'], rates: [{ colors: ['Black'], pricePerSize: { '36': 211, '46': 223 }, samplePrice: 271 }] },
      { name: 'Premium Polo', slug: 'premium-polo', gsm: 220, colors: ['Black'], sizes: ['36', '46'], rates: [{ colors: ['Black'], pricePerSize: { '36': 267, '46': 279 }, samplePrice: 327 }] },
    ] }] }
    const r = await runCase({ buyerText: 'polo', reply: 'Polo mein Cotton Polo ₹211 aur Premium Polo ₹267 hai sir (220gsm) 👉 https://sale91.com/catalog', history: [{ buyerMessage: '1200pcs chahiye, rate kya hai?', aiReply: 'Kaunsa product sir?' }], catalogData })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /Cotton Polo ₹211–₹223; Premium Polo ₹267–₹279/)
    assert.match(r.sent[0].message, /10\+ total pcs/)
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
    assert.deepEqual(r.errors, [])
  }],
  ['plain polo details preserve current ranges without replacing a fabric answer', async () => {
    const catalogData = { categories: [{ products: [
      { name: 'Cotton Polo', slug: 'cotton-polo', gsm: 220, colors: ['Black'], sizes: ['36', '46'], rates: [{ colors: ['Black'], pricePerSize: { '36': 211, '46': 223 }, samplePrice: 271 }] },
      { name: 'Premium Polo', slug: 'premium-polo', gsm: 220, colors: ['Black'], sizes: ['36', '46'], rates: [{ colors: ['Black'], pricePerSize: { '36': 267, '46': 279 }, samplePrice: 327 }] },
    ] }] }
    const buyerText = 'Please send me the details of both polo t-shirts.'
    const r = await runCase({ buyerText, reply: 'Cotton Polo ₹211; Premium Polo ₹267 (bulk) sir.', catalogData })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /Cotton Polo ₹211–₹223; Premium Polo ₹267–₹279/)
    assert.match(r.sent[0].message, /10\+ total pcs, by colour\/size/)
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
    assert.deepEqual(r.errors, [])
    const counted = await runCase({ buyerText, reply: 'Polo 2 hain sir — Cotton Polo ₹211 👉 https://sale91.com/catalog/p/cotton-polo, Premium Polo ₹267 👉 https://sale91.com/catalog/p/premium-polo', catalogData })
    assert.equal(counted.sent[0].message, r.sent[0].message)
    assert.equal(counted.logs.at(-1).aiReply, counted.sent[0].message)
    const reply = 'Cotton Polo ₹211; Premium Polo ₹267 in bulk. Fabric details are in the catalog sir.'
    const mixed = await runCase({ buyerText: 'Please send polo fabric details', reply, catalogData })
    assert.equal(mixed.sent[0].message, reply)
    const cooldown = await runCase({ incomingText: buyerText, cooldown: true, catalogData })
    assert.equal(cooldown.requests.length, 0)
    assert.equal(cooldown.sent.length, 0)
  }],
  ['generic polo purchase wording preserves both size ranges through send', async () => {
    const catalogData = { categories: [{ products: [
      { name: 'Cotton Polo', slug: 'cotton-polo', gsm: 220, colors: ['Black'], sizes: ['36', '46'], rates: [{ colors: ['Black'], pricePerSize: { '36': 211, '46': 223 }, samplePrice: 271 }] },
      { name: 'Premium Polo', slug: 'premium-polo', gsm: 220, colors: ['Black'], sizes: ['36', '46'], rates: [{ colors: ['Black'], pricePerSize: { '36': 267, '46': 279 }, samplePrice: 327 }] },
    ] }] }
    const reply = 'Polo comes in 2 options sir — Cotton Polo ₹211 👉 https://sale91.com/catalog/p/cotton-polo, Premium Polo ₹267 👉 https://sale91.com/catalog/p/premium-polo'
    const r = await runCase({ buyerText: 'We need polo tshirt', reply, catalogData })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /Cotton Polo ₹211–₹223; Premium Polo ₹267–₹279.*10\+ total pcs, by colour\/size/)
    assert.deepEqual(r.errors, [])
    const hindiIntro = await runCase({ buyerText: 'We need polo tshirt', reply: reply.replace('comes in 2 options', 'mein 2 option hai'), catalogData })
    assert.match(hindiIntro.sent[0].message, /Cotton Polo ₹211–₹223; Premium Polo ₹267–₹279.*by colour\/size/)
    const selectedReply = 'Cotton Polo size 46 ₹223; Premium Polo size 46 ₹279 sir'
    const selected = await runCase({ buyerText: 'We need polo size 46 price', reply: selectedReply, catalogData })
    assert.equal(selected.sent[0].message, selectedReply)
    const held = await runCase({ buyerText: 'We need polo refund', reply: '[DEFER]', catalogData })
    assert.equal(held.sent.length, 0)
    assert.equal(held.pending.size, 1)
  }],
  ['specific polo sample quote and owner handoff preserve their paths', async () => {
    const catalogData = { categories: [{ products: [
      { name: 'Cotton Polo', slug: 'cotton-polo', gsm: 220, colors: ['Black'], sizes: ['36', '46'], rates: [{ colors: ['Black'], pricePerSize: { '36': 211, '46': 223 }, samplePrice: 271 }] },
      { name: 'Premium Polo', slug: 'premium-polo', gsm: 220, colors: ['Black'], sizes: ['36', '46'], rates: [{ colors: ['Black'], pricePerSize: { '36': 267, '46': 279 }, samplePrice: 327 }] },
    ] }] }
    const reply = 'Cotton Polo sample ₹271; Premium Polo sample ₹327 sir.'
    const sample = await runCase({ buyerText: '2 polo samples price', reply, catalogData })
    assert.equal(sample.sent[0].message, reply)
    const held = await runCase({ buyerText: 'polo refund', reply: '[DEFER]', catalogData })
    assert.equal(held.sent.length, 0)
    assert.equal(held.pending.size, 1)
  }],
  ['coupon typo after an owner promise queues a tracked handoff', async () => {
    const r = await runCase({ buyerText: 'Kindly send discount ode for hoodie I have to place order', reply: 'Fixed price sir.', history: [{ deferReason: 'manual_reply', aiReply: 'Ok. 2 pcs will add' }] })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.size, 1)
    const held = r.pending.get('buyer-test').messages[0]
    assert.equal(held.logData.deferReason, 'coupon_code_handoff')
    assert.deepEqual(Array.from(held.messageIds), ['inbound-test'])
    assert.ok(held.logData.costUsd > 0)
  }],
  ['conflicting coupon examples are removed before the prompt while bargaining remains', async () => {
    const knowledge = [
      { source: 'CORRECTION', title: 'Code request', similarity: 0.8, content: 'Buyer: Please provide a coupon code\nCorrect reply: Fixed price sir. We work with tight margin' },
      { source: 'CORRECTION', title: 'Ordinary bargain', similarity: 0.8, content: 'Buyer: Give me a lower price\nCorrect reply: Fixed price sir.' },
    ]
    const r = await runCase({ buyerText: 'Could I have a coupon?', reply: 'How many pieces in total sir?', knowledge })
    const prompt = r.requests[0].messages[0].content
    assert.doesNotMatch(prompt, /Please provide a coupon code|tight margin/)
    assert.match(prompt, /Give me a lower price/)
    assert.equal(r.sent[0].message, 'How many pieces in total sir?')
  }],
  ['coupon extension preserves owner cooldown and existing code help', async () => {
    const history = [{ deferReason: 'manual_reply', aiReply: 'Ok. 2 pcs will add' }]
    const held = await runCase({ cooldown: true, incomingText: 'Kindly send discount ode for hoodie', history })
    assert.equal(held.requests.length, 0)
    assert.equal(held.sent.length, 0)
    const help = await runCase({ buyerText: 'Where do I enter my coupon code?', reply: 'Paste it at checkout sir.', history })
    assert.equal(help.pending.size, 0)
    assert.equal(help.sent[0].message, 'Paste it at checkout sir.')
  }],
  ['discontinued-size purchase intent gets live stock and a safe sent answer', async () => {
    const stockSnapshot = { fetchedAt: Date.now(), inStock: { 'Oversize 240gsm': { 'Off-white': { XS: 1, S: 1, M: 1, L: 1 } } }, oos: { 'Oversize 240gsm': { 'Off-white': 'XS,S,M' } }, coming: {} }
    const r = await runCase({ stockSnapshot, buyerText: 'I need oversized 240 gsm off white XS S M sizes', reply: 'Off-white XS/S will arrive in 4 days.' })
    assert.match(r.requests[0].messages[0].content, /LIVE STOCK DATA/)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /XS won't be restocked/)
    assert.match(r.sent[0].message, /S\/M are out of stock now/)
    assert.doesNotMatch(r.sent[0].message, /4 days/)
    assert.equal(r.logs.at(-1).aiReply, r.sent[0].message)
  }],
  ['stock outage keeps the size policy and queues unresolved availability', async () => {
    const r = await runCase({ stockThrows: true, buyerText: '240gsm Off-white XS M available?', reply: 'XS and M available.' })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /XS won't be restocked/)
    assert.doesNotMatch(r.sent[0].message, /are available/)
    assert.equal(r.pending.size, 1)
    assert.equal(r.pending.get('buyer-test').messages[0].logData.deferReason, 'claude_partial_defer')
  }],
  ['Black XS and owner complaint boundaries stay unchanged', async () => {
    for (const buyerText of ['240gsm Black XS available?', '240gsm Off-white XS refund update?']) {
      const r = await runCase({ buyerText, reply: '[DEFER]' })
      assert.equal(r.sent.length, 0)
      assert.equal(r.pending.size, 1)
    }
  }],
  ['manual cooldown precedes discontinued-size policy', async () => {
    const r = await runCase({ cooldown: true, incomingText: 'I need 240gsm Off-white XS S' })
    assert.equal(r.sent.length, 0)
    assert.equal(r.requests.length, 0)
  }],
  ['Hindi invoice answer is repaired before transport and recorded once', async () => {
    const original = 'Your bills sync once you log in sir 👉 https://example.invalid/login'
    const fixed = 'Login karte hi aapke bills sync ho jayenge sir 👉 https://example.invalid/login'
    const r = await runCase({ buyerText: 'Sir invoice download kaise karna hai?', reply: original, rewriteReply: fixed, history: [{ buyerMessage: 'Please share your office location', status: 'REPLIED' }] })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0].message, fixed)
    assert.equal(r.logs.at(-1).aiReply, fixed)
    assert.equal(r.logs.at(-1).sentViaWwbun, true)
  }],
  ['Roman Hindi product spelling reaches the reverse language repair', async () => {
    const r = await runCase({ buyerText: 'Plain tee chaihay mujay', reply: 'Which fit do you want sir?', rewriteReply: 'Kaunsa fit chahiye sir?' })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, 'Kaunsa fit chahiye sir?')
  }],
  ['an explicit English preference prevents reverse repair', async () => {
    const original = 'Your bills sync once you log in sir'
    const r = await runCase({ buyerText: 'Invoice kaise milega?', reply: original, preferredLanguage: 'english' })
    assert.equal(r.rewriteRequests.length, 0)
    assert.equal(r.sent[0].message, original)
  }],
  ['a neutral product-only turn does not trigger Hindi translation', async () => {
    const r = await runCase({ buyerText: 'Polo', reply: 'Which colour do you want sir?', history: [{ buyerMessage: 'Mujhe shirts chahiye', status: 'REPLIED' }] })
    assert.equal(r.rewriteRequests.length, 0)
  }],
  ['Hindi rewrite cannot change a size before transport', async () => {
    const original = 'We have sizes S to XXL sir'
    const r = await runCase({ buyerText: 'Sizes kya hai?', reply: original, rewriteReply: 'S se XL sizes hain sir' })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, original)
  }],
  ['Hindi rewrite outage preserves delivery', async () => {
    const original = 'Your bills sync once you log in sir'
    const r = await runCase({ buyerText: 'Invoice kaise milega?', reply: original, rewriteThrows: true })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, original)
    assert.equal(r.logs.at(-1).status, 'REPLIED')
  }],
  ['Hindi reply repair cannot override the owner handoff', async () => {
    const r = await runCase({ buyerText: 'Refund kab milega?', reply: '[DEFER]' })
    assert.equal(r.rewriteRequests.length, 0)
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.get('buyer-test').messages[0].logData.status, 'DEFERRED')
  }],
  ['repeated stock pointer after an alert becomes a tracked owner handoff', async () => {
    const r = await runCase({ buyerText: 'Acid wash ka stock kab refill hoga, information nahi hai', reply: 'Coming Soon tab mein update aata rehta hai sir, wahin check karte rahiye', history: [{ buyerMessage: 'Black M acid wash kab aayega?', aiReply: 'Alert laga lijiye sir https://www.bulkplaintshirt.com/delhi-stock.html?alert=1', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.sent.length, 0)
    const held = r.pending.get('buyer-test')?.messages[0]
    assert.ok(held)
    assert.equal(held.logData.deferReason, 'restock_pointer_handoff')
    assert.deepEqual(Array.from(held.messageIds), ['inbound-test'])
    assert.ok(held.logData.costUsd > 0)
  }],
  ['first stock pointer becomes a helpful alert offer', async () => {
    const r = await runCase({ buyerText: 'Acid wash kab restock hoga?', reply: 'Check Coming Soon sir.' })
    assert.equal(r.pending.size, 0)
    assert.match(r.sent[0].message, /alert=1/)
    assert.match(r.sent[0].message, /WhatsApp/)
    assert.doesNotMatch(r.sent[0].message, /Coming Soon/)
  }],
  ['matching new timing is not replaced by the restock guard', async () => {
    const r = await runCase({ buyerText: 'Acid wash kab restock hoga?', reply: 'Black M acid wash 4 din mein aa jayega sir.', history: [{ buyerMessage: 'Black M acid wash kab aayega?', aiReply: 'Check Coming Soon sir.', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.pending.size, 0)
    assert.match(r.sent[0].message, /4 din/)
  }],
  ['new stock subject retains its first-pointer route', async () => {
    const r = await runCase({ buyerText: 'Cotton Polo kab restock hoga?', reply: 'Check Coming Soon sir.', history: [{ buyerMessage: 'Black M acid wash kab aayega?', aiReply: 'Check Coming Soon sir.', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.pending.size, 0)
    assert.equal(r.sent.length, 1)
  }],
  ['stock timing plus photo answer keeps partial handoff', async () => {
    const r = await runCase({ buyerText: 'Acid wash kab restock hoga, hoodie photos bhi bhejo?', reply: 'Hoodie photos yahan dekh lijiye sir: https://sale91.com/catalog [DEFER]', history: [{ buyerMessage: 'Black M acid wash kab aayega?', aiReply: 'Check Coming Soon sir.', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /Hoodie photos/)
    assert.equal(r.pending.get('buyer-test').messages[0].logData.deferReason, 'claude_partial_defer')
  }],
  ['manual cooldown remains ahead of stock-pointer review', async () => {
    const r = await runCase({ cooldown: true, incomingText: 'Acid wash stock kab refill hoga?', reply: 'Check Coming Soon sir.', history: [{ buyerMessage: 'Black M acid wash kab aayega?', aiReply: 'Check Coming Soon sir.', status: 'REPLIED', createdAt: new Date(Date.now() - 60000) }] })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.size, 0)
    assert.equal(r.logs.at(-1).status, 'COOLDOWN')
  }],
  ['known-quantity coupon refusal becomes a tracked owner handoff', async () => {
    const r = await runCase({ buyerText: 'Please give me a discount code', reply: 'Fixed price sir. We have a tight margin.', history: [{ buyerMessage: 'Black tees: 63 pcs', aiReply: 'Please order online.', status: 'REPLIED' }] })
    assert.equal(r.sent.length, 0)
    const held = r.pending.get('buyer-test')?.messages[0]
    assert.ok(held)
    assert.equal(held.logData.deferReason, 'coupon_code_handoff')
    assert.deepEqual(Array.from(held.messageIds), ['inbound-test'])
    assert.ok(held.logData.costUsd > 0)
  }],
  ['coupon handoff takes precedence over the large-buyer discount guard', async () => {
    const r = await runCase({ buyerText: 'Discount code for 850 pcs please', reply: 'Fixed price sir.' })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.get('buyer-test').messages[0].logData.deferReason, 'coupon_code_handoff')
  }],
  ['coupon without a known count can ask the quantity', async () => {
    const r = await runCase({ buyerText: 'Could you give me a coupon please?', reply: 'How many pieces in total sir?' })
    assert.equal(r.pending.size, 0)
    assert.equal(r.sent[0].message, 'How many pieces in total sir?')
  }],
  ['ordinary small-order bargaining retains fixed-price wording', async () => {
    const r = await runCase({ buyerText: '63 pcs, any discount please?', reply: 'Fixed price sir.' })
    assert.equal(r.pending.size, 0)
    assert.equal(r.sent[0].message, 'Fixed price sir.')
  }],
  ['existing-code help remains answerable after quantity is known', async () => {
    const r = await runCase({ buyerText: 'Where do I enter my coupon code?', reply: 'Enter it on the Pay Now page sir.', history: [{ buyerMessage: '63 pcs', status: 'REPLIED' }] })
    assert.equal(r.pending.size, 0)
    assert.equal(r.sent[0].message, 'Enter it on the Pay Now page sir.')
  }],
  ['coupon guard preserves a mixed answer and its handoff', async () => {
    const r = await runCase({ buyerText: 'Send hoodie photos and a coupon please', reply: 'All hoodie photos are in the catalogue sir: https://sale91.com/catalog [DEFER]', history: [{ buyerMessage: '63 pcs', status: 'REPLIED' }] })
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /hoodie photos/)
    assert.equal(r.pending.get('buyer-test').messages[0].logData.deferReason, 'claude_partial_defer')
  }],
  ['manual cooldown remains ahead of coupon handoff', async () => {
    const r = await runCase({ cooldown: true, incomingText: 'Coupon for 63 pcs please', reply: 'Fixed price sir.' })
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.size, 0)
    assert.equal(r.logs.at(-1).status, 'COOLDOWN')
  }],
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
  ['numeric English follow-up repairs product-scoped me before transport', async () => {
    const reply = '180gsm oversize me yes sir, ₹213 per pc 👉 https://example.invalid/oversize'
    const fixed = 'Yes sir, 180gsm oversize is ₹213 per pc 👉 https://example.invalid/oversize'
    const r = await runCase({ buyerText: '12 tshirts = 213 right', reply, rewriteReply: fixed, history: [{ buyerMessage: 'Can you tell me the price of oversized shirts?', aiReply: 'Check the catalogue sir', status: 'REPLIED' }] })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0].message, fixed)
    assert.equal(r.logs.at(-1).aiReply, fixed)
  }],
  ['English pronoun me does not cause a paid rewrite', async () => {
    const reply = 'Tell me which 180gsm oversize you need sir 👉 https://example.invalid/oversize'
    const r = await runCase({ buyerText: 'Please share the sizes', reply })
    assert.equal(r.rewriteRequests.length, 0)
    assert.equal(r.sent[0].message, reply)
  }],
  ['product-scoped me preserves explicit Hindi preference', async () => {
    const reply = '180gsm oversize me yes sir, ₹213 per pc'
    const r = await runCase({ buyerText: '12 tshirts = 213 right', reply, preferredLanguage: 'hindi' })
    assert.equal(r.rewriteRequests.length, 0)
    assert.equal(r.sent[0].message, reply)
  }],
  ['product-scoped me rejects a rewrite with a changed price', async () => {
    const reply = '180gsm oversize me yes sir, ₹213 per pc'
    const r = await runCase({ buyerText: 'Please confirm the price', reply, rewriteReply: 'Yes sir, 180gsm oversize is ₹214 per pc' })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent[0].message, reply)
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
  ['short English buying fragment repairs the sent answer', async () => {
    const original = 'Cotton hoodie hai sir, sizes S se XXL 👉 https://example.invalid/hoodie'
    const english = 'Cotton hoodie sir, sizes S to XXL 👉 https://example.invalid/hoodie'
    const r = await runCase({ buyerText: 'Looking for navy cotton hoodies', reply: original, rewriteReply: english })
    assert.equal(r.rewriteRequests.length, 1)
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0].message, english)
    assert.ok(r.logs.some(row => row.status === 'REPLIED' && row.sentViaWwbun))
  }],
  ['Hindi buying fragment does not trigger English repair', async () => {
    const original = 'Hoodie hai sir'
    const r = await runCase({ buyerText: 'Looking for hoodies, navy mein milega kya?', reply: original })
    assert.equal(r.rewriteRequests.length, 0)
    assert.equal(r.sent[0].message, original)
  }],
  ['buying fragment preserves explicit Hindi preference', async () => {
    const r = await runCase({ buyerText: 'Looking for cotton hoodies', reply: 'Hoodie hai sir', preferredLanguage: 'hindi' })
    assert.equal(r.rewriteRequests.length, 0)
    assert.equal(r.sent[0].message, 'Hoodie hai sir')
  }],
  ['English buying reply avoids a redundant rewrite', async () => {
    const reply = 'Please check the hoodie description sir 👉 https://example.invalid/hoodie'
    const r = await runCase({ buyerText: 'Looking for cotton hoodies', reply })
    assert.equal(r.rewriteRequests.length, 0)
    assert.equal(r.sent[0].message, reply)
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
    const r = await runCase({ buyerText: 'When will the women range launch?', timedFacts: [
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
  ['GSM hint preserves catalogue price ranges in the actual provider request', async () => {
    const catalogData = { categories: [{ products: [
      { name: 'Example Round Neck', slug: 'example-round-neck', gsm: 180, colors: ['Black', 'White'], sizes: ['M', 'XXL'], rates: [
        { colors: ['Black'], pricePerSize: { M: 211, XXL: 223 }, samplePrice: 277 },
        { colors: ['White'], pricePerSize: { M: 239, XXL: 251 }, samplePrice: 299 },
      ] },
      { name: 'Oversize 180gsm', slug: 'oversize-180gsm', gsm: 180, colors: ['Black'], sizes: ['M'], rates: [
        { colors: ['Black'], pricePerSize: { M: 313 }, samplePrice: 379 },
      ] },
    ] }] }
    const r = await runCase({ catalogData, buyerText: '180gsm tshirt catalogue with prices please', reply: 'Bulk ranges from ₹211–₹251 for regular and ₹313 for oversize sir. Which fit?' })
    assert.match(r.requests[0].messages[0].content, /bulk \(10\+ total pcs\) ₹211–₹251 per piece/)
    assert.match(r.requests[0].messages[0].content, /sample \(under 10 total pcs\) ₹277–₹299 per piece/)
    assert.doesNotMatch(r.requests[0].messages[0].content, /₹150\b|₹142\b|₹177\b/)
    assert.equal(r.sent.length, 1)
    assert.match(r.sent[0].message, /Example Round Neck: ₹211–₹251/)
    assert.match(r.sent[0].message, /ranges by colour\/size/)
    const control = await runCase({ catalogData, buyerText: 'Black XXL round neck 180gsm price for 2 pcs', reply: 'The sample price is ₹277 per piece sir.' })
    assert.doesNotMatch(control.requests[0].messages[0].content, /GSM ALONE IS NOT A PRODUCT/)
    assert.equal(control.sent[0].message, 'The sample price is ₹277 per piece sir.')
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
  ['cart transfer and limit questions reach payment triage', async () => {
    for (const question of ['Bhai bank limit over hai. Online transfer kar du? Website mein option nahi aa raha.', 'Can I use bank transfer?', 'NEFT option nahi hai', 'IMPS kar sakta hu?', 'My daily limit is exhausted', 'Can I transfer online?']) {
      const r = await runCase({ incomingText: `Total 14 pcs · 5 kg\nOversize 240gsm\nBlack M:14\nRef: wo_example\n${question}`, reply: '[DEFER]' })
      assert.equal(r.requests.length, 1, question)
      assert.ok(r.requests[0].messages[0].content.includes(question), question)
      assert.equal(r.sent.length, 0, question)
      assert.equal(r.pending.size, 1, question)
      assert.deepEqual(r.errors, [])
    }
  }],
  ['cart payment context preserves cooldown and partial mode', async () => {
    const incomingText = 'Total 14 pcs · 5 kg\nOversize 240gsm\nBlack M:14\nRef: wo_example\nOnline transfer krdu?'
    const cool = await runCase({ incomingText, cooldown: true })
    assert.equal(cool.requests.length, 0)
    assert.equal(cool.sent.length, 0)
    assert.equal(cool.logs.at(-1).status, 'COOLDOWN')
    const partial = await runCase({ incomingText, active: false })
    assert.equal(partial.requests.length, 0)
    assert.equal(partial.sent.length, 0)
  }],
  ['cart transport wording keeps checkout routing', async () => {
    const r = await runCase({ incomingText: 'Total 14 pcs · 5 kg\nOversize 240gsm\nBlack M:14\nTransport\nRef: wo_example\nSend directly to my shop' })
    assert.equal(r.requests.length, 0)
    assert.equal(r.logs.at(-1).deferReason, 'cart_block_order_intent')
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
    const r = await runCase({ buyerText: 'Oversize 240gsm Red restock?', timedFacts: [{ content: `[stated ${date}] Buyer asked: "Oversize 240gsm Red restock?" — Ketu's answer: "8-9 din mein aayega"` }] })
    const prompt = r.requests[0].messages[0].content
    assert.match(prompt, /4-5 days/)
    assert.doesNotMatch(prompt, /8-9 din/)
    assert.equal(r.sent.length, 1)
    assert.equal(r.logs.at(-1).status, 'REPLIED')
  }],
  ['runtime ages bounded Hindi timing in both fact and stock paths', async () => {
    const date = new Date(Date.now() + 19800000 - 2 * 86400000).toISOString().slice(0, 10)
    const r = await runCase({ buyerText: 'Oversize 240gsm Red M kab aayega?', reply: '6-8 din sir', timedFacts: [{ content: `[stated ${date}] Buyer asked: "Oversize 240gsm Red restock?" — Ketu's answer: "आट से दस दिन में आएगा"` }], stockSnapshot: { fetchedAt: Date.now(), inStock: { 'Oversize 240gsm': { Red: { M: 1 }, White: { M: 1 } } }, oos: { 'Oversize 240gsm': { Red: 'M', White: 'M' } }, coming: {} } })
    const prompt = r.requests[0].messages[0].content
    assert.match(prompt, /6-8 days/)
    assert.match(prompt, /Red \[out: M[^\n]*6-8 days/)
    assert.match(prompt, /White \[out: M[^\n]*NO shipment/)
    assert.doesNotMatch(prompt, /आट से दस|dated estimate/)
    assert.equal(r.sent.length, 1)
    assert.equal(r.errors.length, 0)
  }],
  ['runtime omits due Hindi timing without inventing a new wait', async () => {
    const date = new Date(Date.now() + 19800000 - 8 * 86400000).toISOString().slice(0, 10)
    const r = await runCase({ buyerText: 'Oversize 240gsm Red M kab aayega?', reply: '[DEFER]', timedFacts: [{ content: `[stated ${date}] Buyer asked: "Oversize 240gsm Red restock?" — Ketu's answer: "आठ से दस दिन में आएगा"` }] })
    assert.doesNotMatch(r.requests[0].messages[0].content, /आठ से दस|Current timing estimate/)
    assert.equal(r.sent.length, 0)
    assert.equal(r.pending.size, 1)
    assert.equal(r.errors.length, 0)
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
  ['multipart product reply retains its content and adds omitted shipping details', async () => {
    const buyerText = 'Please share details for oversize tees:\nSizes and colours\nBulk price and MOQ\nFabric composition and photos\nShipping details'
    const reply = 'Cotton oversize tees. Current prices and photos 👉 https://sale91.com/catalog/p/oversize-210gsm'
    const r = await runCase({ buyerText, reply })
    assert.equal(r.sent.length, 1, r.errors.join('\n'))
    assert.ok(r.sent[0].message.startsWith(reply))
    assert.match(r.sent[0].message, /Shipping options and charges show at checkout/)
    assert.match(r.sent[0].message, /shipping-calculator\.html/)
    assert.equal(r.pending.size, 0)
  }],
  ['multipart shipping guard preserves an owner-only payment handoff', async () => {
    const r = await runCase({ buyerText: 'Please share details for oversize tees:\nSizes and colours\nBulk price and MOQ\nFabric composition and photos\nShipping details\nPayment was taken twice.', reply: '[DEFER]' })
    assert.equal(r.sent.length, 0, r.errors.join('\n'))
    assert.equal(r.pending.size, 1)
  }],
  ['multipart shipping does not duplicate an existing checkout answer', async () => {
    const reply = 'Cotton tees 👉 https://sale91.com/catalog/p/oversize-210gsm — shipping options and charges show at checkout.'
    const r = await runCase({ buyerText: 'Please share details for oversize tees:\nSizes and colours\nBulk price and MOQ\nFabric composition and photos\nShipping details', reply })
    assert.equal(r.sent.length, 1, r.errors.join('\n'))
    assert.equal(r.sent[0].message, reply)
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
