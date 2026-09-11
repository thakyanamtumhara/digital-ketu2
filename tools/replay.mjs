// REPLAY HARNESS — the only honest pre-ship check for a rulebook change. COSTS KETU MONEY.
//
//   node tools/replay.mjs tools/cases/<file>.json [--prompt local|live] [--model claude-opus-5] [--runs 1] [--only id,id]
//
// Rebuilds the production request the way runAiFlow does: system = [static prompt (cached), catalog
// block (cached)], user = [stock block / photo block / winter line when the case asks for them] +
// RECENT CONVERSATION + BUYER'S NEW MESSAGE, called with thinking:disabled on the live reply model.
// Not reproduced: vector-search style pairs / KNOWLEDGE BASE chunks (per-query, style-only) and
// buyer profile / order lookup (need a real number). Good enough to catch a rule that does not fire.
//
// --prompt local  = DEFAULT_SYSTEM_PROMPT from the repo (what you are ABOUT to ship)
// --prompt live   = /api/settings systemPrompt (what is live now; needs ~/.dk2_read_token)
// Key: ~/.dk2_anthropic_key (600) or ANTHROPIC_API_KEY. Each case ≈ ₹3-4 warm, first call ≈ ₹55 (cache write).
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--'))
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d }
if (!file) { console.error('usage: node tools/replay.mjs cases.json [--prompt local|live] [--model id] [--runs n] [--only a,b]'); process.exit(2) }
const PROMPT_SRC = opt('prompt', 'local')
const MODEL = opt('model', 'claude-opus-5')
const RUNS = Number(opt('runs', 1))
const ONLY = (opt('only', '') || '').split(',').filter(Boolean)

const keyFile = join(homedir(), '.dk2_anthropic_key')
const KEY = process.env.ANTHROPIC_API_KEY || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '')
if (!KEY) { console.error('no API key: put it in ~/.dk2_anthropic_key (chmod 600) or ANTHROPIC_API_KEY'); process.exit(2) }
const READ = readFileSync(join(homedir(), '.dk2_read_token'), 'utf8').trim()
const BASE = 'https://digital-ketu2-production.up.railway.app'
const api = async p => (await fetch(`${BASE}${p}`, { headers: { 'X-DK-Read-Token': READ } })).json()

// ---- system blocks, built like runAiFlow ----
let staticPrompt
if (PROMPT_SRC === 'live') {
  staticPrompt = (await api('/api/settings')).systemPrompt
} else {
  const mod = await import('../server/process.js')
  staticPrompt = mod.DEFAULT_SYSTEM_PROMPT
}
const guide = await api('/api/knowledge/chunks?source=STYLE_GUIDE&pageSize=5').catch(() => null)
const styleGuide = ((guide && (guide.chunks || guide.items || [])) || []).find(c => c.sourceId === 'om_style_guide')
if (styleGuide) staticPrompt += `\n\nOM'S COMMUNICATION STYLE:\n${styleGuide.content}`

const { getCatalogFacts, canonicalizeCatalogLinks } = await import('../server/catalog-facts.js')
const { block: catalogBlock, products: catalogProducts } = await getCatalogFacts()

// ---- optional per-case blocks ----
const { getStockSnapshot, formatStockBlock, resolveUnnamedProduct } = await import('../server/stock-lookup.js')
const { formatTimedFactsBlock } = await import('../server/timed-facts.js')
const { getPhotoIndex, formatPhotoBlock } = await import('../server/photo-links.js')
const { winterStockLine, EXPORT_ASK_RE, EXPORT_HINT, istTimeBlock, deliveryDaysGuard, bigBuyerDiscountGuard, formatConversationHistory } = await import('../server/process.js')
const { gsmAmbiguityHint } = await import('../server/gsm-hint.js')
const { repairEnglishReply } = await import('../server/reply-language.js')
const rewriteClient = { messages: { create: async body => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw Error(`Rewrite HTTP ${res.status}`)
  return res.json()
} } }
let stockBlock = null, photoBlock = null, stockSnapshot = null
const cases = JSON.parse(readFileSync(file, 'utf8')).filter(c => !ONLY.length || ONLY.includes(c.id))
const tfRes = await api('/api/knowledge/chunks?source=TIMED_FACT&pageSize=8').catch(() => null)
const timedFacts = ((tfRes && (tfRes.chunks || tfRes.items)) || []).map(c => ({ content: c.content })) // mirrors fetchTimedFacts (2026-09-08)
if (cases.some(c => c.stock && !c.stockSnapshot)) { stockSnapshot = await getStockSnapshot(); stockBlock = formatStockBlock(stockSnapshot, { timedFacts }) }
if (cases.some(c => c.photo)) photoBlock = formatPhotoBlock(await getPhotoIndex())

function userPromptFor(c) {
  const now = c.at ? Date.parse(c.at) : Date.now()
  const caseTimedFacts = c.timedFacts || timedFacts
  const caseSnapshot = c.stockSnapshot || stockSnapshot
  const caseStockBlock = caseSnapshot ? formatStockBlock(caseSnapshot, { timedFacts: caseTimedFacts, now }) : stockBlock
  let p = ''
  if (c.history && c.history.length) {
    p += formatConversationHistory(c.history.map(h => ({ buyerMessage: h.buyer, aiReply: h.ai, status: h.deferred ? 'DEFERRED' : (h.manual || h.silent ? 'SKIPPED' : 'REPLIED'), deferReason: h.manual ? 'manual_reply' : (h.silent ? 'ai_chose_silence' : null), createdAt: h.at })))
  }
  p += `BUYER'S NEW MESSAGE:\n${c.msg}\n\nReply as Ketu's assistant:`
  p = istTimeBlock(c.at ? Date.parse(c.at) : Date.now()) + p // mirrors buildUserPrompt; case.at = ISO with +05:30 to pin a moment
  if (c.winter) p = `❄️ WINTER STOCK LINE (the seasonal restock answer for hoodie / sweatshirt / zip-hoodie / any winter item, computed for today's date in Ketu's words — relay it for a winter restock-timing ask unless a ⏰ entry above or a 📦 LIVE STOCK DATA in-stock listing answers more specifically; never add a date of your own): "${winterStockLine()}"\n\n${p}`
  if (c.photo && photoBlock) p = photoBlock + '\n\n' + p
  if (c.stock && caseStockBlock) {
    const unnamed = resolveUnnamedProduct(caseSnapshot, c.msg) // mirrors runAiFlow (2026-09-05)
    p = caseStockBlock + (unnamed ? '\n' + unnamed : '') + '\n\n' + p
  }
  const timedBlock = formatTimedFactsBlock(caseTimedFacts, now, c.msg)
  if (timedBlock) p = timedBlock + '\n\n' + p
  if (EXPORT_ASK_RE.test(c.msg)) p = EXPORT_HINT + '\n\n' + p // mirrors runAiFlow (2026-09-05)
  const gsmHint = gsmAmbiguityHint(catalogProducts, c.msg) // mirrors runAiFlow (2026-09-06)
  if (gsmHint) p = gsmHint + '\n\n' + p
  return p
}

// --dump <dir>: write system.txt + one user_<id>.txt per case and exit WITHOUT calling the API
// (free proxy runs through the operator's own model, or inspection of exactly what the model sees).
const DUMP = opt('dump', '')
if (DUMP) {
  const { mkdirSync, writeFileSync } = await import('fs')
  mkdirSync(DUMP, { recursive: true })
  writeFileSync(join(DUMP, 'system.txt'), staticPrompt + (catalogBlock ? '\n\n' + catalogBlock : ''))
  for (const c of cases) writeFileSync(join(DUMP, `user_${c.id}.txt`), userPromptFor(c))
  writeFileSync(join(DUMP, 'cases.json'), JSON.stringify(cases, null, 1))
  console.log(`dumped system.txt (${staticPrompt.length + (catalogBlock || '').length} chars) + ${cases.length} user prompts → ${DUMP}`)
  process.exit(0)
}

const PRICE = { 'claude-opus-5': [5, 25, 0.5, 10], 'claude-opus-4-8': [5, 25, 0.5, 10], 'claude-fable-5-1': [10, 50, 0.25, 20] }
const [pIn, pOut, pRead, pWrite1h] = PRICE[MODEL] || [5, 25, 0.5, 10]
let usd = 0, pass = 0, total = 0
const results = []
for (const c of cases) {
  for (let r = 0; r < RUNS; r++) {
    total++
    const body = {
      model: MODEL, max_tokens: 500,
      system: [{ type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }].concat(catalogBlock ? [{ type: 'text', text: catalogBlock, cache_control: { type: 'ephemeral', ttl: '1h' } }] : []),
      messages: [{ role: 'user', content: userPromptFor(c) }],
    }
    if (!/fable|mythos/.test(MODEL)) body.thinking = { type: 'disabled' }
    else body.output_config = { effort: 'low' }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'extended-cache-ttl-2025-04-11', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json()
    if (j.error) { console.log(`\n❌ ${c.id} API ERROR ${j.error.message}`); continue }
    let txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim()
    const u = j.usage || {}
    usd += ((u.input_tokens || 0) * pIn + (u.cache_read_input_tokens || 0) * pRead + (u.cache_creation_input_tokens || 0) * pWrite1h + (u.output_tokens || 0) * pOut) / 1e6
    const fails = []
    // Mirror the production post-model guards (2026-09-09) so a replay judges what the buyer would get.
    {
      txt = canonicalizeCatalogLinks(txt, catalogProducts)
      const historyText = (c.history || []).map(h => `Buyer: ${h.buyer}\nAssistant: ${h.ai || ''}`).join('\n')
      const g1 = deliveryDaysGuard({ buyerText: c.msg, reply: txt })
      if (g1) { console.log(`   ⚙️ delivery-days guard replaced the model reply`); txt = g1 }
      const g2 = bigBuyerDiscountGuard({ buyerText: c.msg, historyText, reply: txt })
      if (g2) { console.log(`   ⚙️ discount guard replaced the model reply`); txt = g2 }
    }
    if (!/^\s*\[(DEFER|SKIP)\]\s*$/.test(txt)) {
      const repaired = await repairEnglishReply({
        anthropic: rewriteClient, reply: txt, buyerText: c.msg, preferredLanguage: c.preferredLanguage,
        history: (c.history || []).map(h => ({ buyerMessage: h.buyer, deferReason: h.manual ? 'manual_reply' : null })),
      })
      usd += repaired.costUsd
      txt = repaired.reply
      if (repaired.attempted) console.log(`   English repair: ${repaired.changed ? 'applied' : 'kept original'}`)
    }
    for (const m of (c.must || [])) if (!new RegExp(m, 'i').test(txt)) fails.push(`missing /${m}/`)
    for (const m of (c.mustNot || [])) if (new RegExp(m, 'i').test(txt)) fails.push(`forbidden /${m}/`)
    const ok = fails.length === 0
    if (ok) pass++
    results.push({ id: c.id, ok, reply: txt, fails })
    console.log(`\n${ok ? '✅' : '❌'} ${c.id}${RUNS > 1 ? ` (run ${r + 1})` : ''}  [cache read ${u.cache_read_input_tokens || 0}, write ${u.cache_creation_input_tokens || 0}]`)
    console.log('   buyer:', c.msg.slice(0, 120))
    console.log('   reply:', txt.replace(/\n/g, ' ⏎ ').slice(0, 300))
    if (!ok) console.log('   >>>', fails.join('; '))
  }
}
console.log(`\n=== ${pass}/${total} passed · prompt=${PROMPT_SRC} · model=${MODEL} · cost $${usd.toFixed(3)} ≈ ₹${(usd * 88).toFixed(0)} ===`)
process.exit(pass === total ? 0 : 1)
