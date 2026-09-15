import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm'
import { resolveTimedFactProduct, detectColoursAndSizes, PRODUCT_NAMED_RE, formatStockBlock } from '../server/stock-lookup.js'

const processUrl = new URL('../server/process.js', import.meta.url)
const source = await readFile(processUrl, 'utf8')

async function runCase({ whatsappNumber = 'buyer-test', reply = 'Address sir: Khanpur.', failCalls = 0, guardThrows = false, cooldown = false, history = [], timedFacts = [], stockSnapshot = null, stockThrows = false, incomingText = null, incomingMessages = null, invoiceKind = 'FRESH', active = true, catalogUnavailable = false, catalogData = null, knowledge = [], recovery = null, buyerText = 'address kya hai', rewriteReply = null, rewriteThrows = false, preferredLanguage = null, imageUrl = null, mediaAvailable = true, gateVerdict = 'ASSISTANT', repliesToday = 0, keywordFilters = [], outboundHistory = [] } = {}) {
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
    setTimeout(fn, ms) { if (recovery) timers.push({ fn, ms }); else if (ms < 30000) queueMicrotask(fn); return { unref() {} } },
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
    './stock-lookup.js': { getStockSnapshot: async () => { if (stockThrows) throw Error('stock unavailable'); return stockSnapshot || {} }, formatStockBlock: snapshot => stockSnapshot ? formatStockBlock(snapshot, { timedFacts }) : '', resolveUnnamedProduct: () => '', unnamedProductCandidates: () => [], unnamedProductGuard() {}, resolveTimedFactProduct, detectColoursAndSizes, PRODUCT_NAMED_RE },
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
      findUnique: async () => ({ whatsappNumber, lastMessageAt: new Date(), cooldownUntil: recovery?.cooldown || (cooldown && ++conversationReads > 1 ? new Date(Date.now() + 60000) : null) }),
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

const tests = [
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
