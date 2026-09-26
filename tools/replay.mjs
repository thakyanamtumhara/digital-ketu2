import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { canonicalizeStockAlertLinks } from '../server/stock-alert-link.js'
import { replyModelParams, responseText, resolveReplyModel } from '../server/reply-models.js'
import { getCatalogFacts, canonicalizeCatalogLinks } from '../server/catalog-facts.js'
import { getStockSnapshot, formatStockBlock, resolveUnnamedProduct } from '../server/stock-lookup.js'
import { scopedTimingBlock } from '../server/timing-scope.js'
import { getPhotoIndex, formatPhotoBlock } from '../server/photo-links.js'
import { winterStockLine, EXPORT_ASK_RE, EXPORT_HINT, istTimeBlock, deliveryDaysGuard, bigBuyerDiscountGuard, formatConversationHistory } from '../server/process.js'
import { gsmAmbiguityHint, gsmPriceRangeGuard } from '../server/gsm-hint.js'
import { poloRateSummaryGuard, poloColourQuoteGuard } from '../server/polo-price.js'
import { sublimationPriceGuard } from '../server/sublimation-price.js'
import { hoodieRateSummaryGuard } from '../server/hoodie-price.js'
import { biowashRateSummaryGuard, currentBiowashQuoteGuard } from '../server/biowash-price.js'
import { customLabelReferralGuard } from '../server/custom-label-referral.js'
import { regularFitBlueHint, regularFitBlueGuard } from '../server/regular-fit-blue.js'
import { pendingProductChoiceGuard } from '../server/product-choice.js'
import { repairReplyLanguage, buyerUsesEnglish } from '../server/reply-language.js'
import { arrivalClockGuard } from '../server/arrival-clock.js'
import { couponCodeGuard } from '../server/coupon-code.js'
import { restockPointerGuard } from '../server/restock-pointer.js'
import { stockAlertOfferGuard } from '../server/stock-alert-offer.js'
import { discontinuedSizeRequest, discontinuedSizeGuard } from '../server/discontinued-size.js'
function userPromptFor(c, { timedFacts, stockSnapshot, stockBlock, photoBlock, catalogProducts }) {
  const now = c.at ? Date.parse(c.at) : Date.parse(c.at)
  const caseTimedFacts = c.timedFacts || timedFacts
  const caseSnapshot = c.stockSnapshot || stockSnapshot
  const caseStockBlock = caseSnapshot ? formatStockBlock(caseSnapshot, { timedFacts: caseTimedFacts, now }) : stockBlock
  let p = ''
  if (c.history && c.history.length) {
    p += formatConversationHistory(c.history.map(h => ({ buyerMessage: h.buyer, aiReply: h.ai, status: h.deferred ? 'DEFERRED' : (h.manual || h.silent ? 'SKIPPED' : 'REPLIED'), deferReason: h.manual ? 'manual_reply' : (h.silent ? 'ai_chose_silence' : null), createdAt: h.at })))
  }
  p += `BUYER'S NEW MESSAGE:\n${c.msg}\n\nReply as Ketu's assistant:`
  p = istTimeBlock(c.at ? Date.parse(c.at) : Date.parse(c.at)) + p // mirrors buildUserPrompt; case.at = ISO with +05:30 to pin a moment
  if (c.winter) p = `❄️ WINTER STOCK LINE (the seasonal restock answer for hoodie / sweatshirt / zip-hoodie / any winter item, computed for today's date in Ketu's words — relay it for a winter restock-timing ask unless a ⏰ entry above or a 📦 LIVE STOCK DATA in-stock listing answers more specifically; never add a date of your own): "${winterStockLine(new Date(c.at))}"\n\n${p}`
  if (c.photo && photoBlock) p = photoBlock + '\n\n' + p
  if ((c.stock || discontinuedSizeRequest(c.msg)) && caseStockBlock) {
    const unnamed = resolveUnnamedProduct(caseSnapshot, c.msg) // mirrors runAiFlow (2026-09-05)
    p = caseStockBlock + (unnamed ? '\n' + unnamed : '') + '\n\n' + p
  }
  const timedBlock = scopedTimingBlock(caseTimedFacts, now, c.msg, (c.history || []).map(h => ({ buyerMessage: h.buyer, deferReason: h.manual ? 'manual_reply' : null, createdAt: h.at })))
  if (timedBlock) p = timedBlock + '\n\n' + p
  if (EXPORT_ASK_RE.test(c.msg)) p = EXPORT_HINT + '\n\n' + p // mirrors runAiFlow (2026-09-05)
  const gsmHint = gsmAmbiguityHint(catalogProducts, c.msg) // mirrors runAiFlow (2026-09-06)
  if (gsmHint) p = gsmHint + '\n\n' + p
  const blueHistory = (c.history || []).map(h => ({ buyerMessage: h.buyer, aiReply: h.ai, deferReason: h.manual ? 'manual_reply' : null, createdAt: h.at }))
  const blueHint = !c.imageUrl && regularFitBlueHint({ products: catalogProducts, buyerText: c.msg, history: blueHistory, now })
  if (blueHint) p = blueHint + '\n\n' + p
  return p
}


export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
export function privateDirectory(path) {
  const absolute = resolve(path)
  for (let p = absolute; ; p = dirname(p)) {
    if (existsSync(join(p, '.git'))) throw Error('Raw replay output must remain outside every git repository')
    if (p === dirname(p)) break
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 })
  chmodSync(absolute, 0o700)
  return absolute
}
export function savePrivate(path, data) {
  privateDirectory(dirname(path))
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}
export function assertFreshReplayOutput(output) {
  const path = join(output, 'calls.json')
  if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).length) throw Error('This output already contains paid/uncertain calls; use a new authorized budget, not a silent rerun')
}
function imageBlocksFor(c) {
  if (c.imageUrl && !c.images?.length) throw Error(`Case ${c.id}: imageUrl alone is not inspected image evidence`)
  return (c.images || []).map(image => {
    if (image.reviewed !== true) throw Error(`Case ${c.id}: inspect image before replay`)
    const data = readFileSync(image.path)
    const mediaType = image.mediaType || ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })[extname(image.path).toLowerCase()]
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mediaType) || !data.length) throw Error('Unsupported or empty replay image')
    return { block: { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } }, evidence: { sourceId: image.sourceId || null, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, mediaType, reviewed: true } }
  })
}
export function freezeReplayInputs({ cases, staticPrompt, catalogBlock = '', catalogProducts = [], timedFacts = [], stockSnapshot = null, photoBlock = null, configuredModel, usdToInr = 88, now = Date.now(), source = {} }) {
  if (!cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw Error('Replay requires nonempty unique case IDs')
  const system = [{ type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }]
  if (catalogBlock) system.push({ type: 'text', text: catalogBlock, cache_control: { type: 'ephemeral', ttl: '1h' } })
  const facts = { catalogProducts, stockSnapshot, timedFacts, photoBlock }
  const frozenCases = cases.map(original => {
    const c = structuredClone(original), images = imageBlocksFor(c)
    c.at ||= new Date(now).toISOString()
    if (!Number.isFinite(Date.parse(c.at))) throw Error('Invalid case time')
    if (images.length) c.imageUrl = 'inspected-local-image'
    let user = userPromptFor(c, { ...facts, stockBlock: null })
    if (images.length > 1) user = `The buyer attached ${images.length} photos in this turn. Consider every photo and answer each requested item. Apply the existing photo, shade-uncertainty and owner-handoff rules to all of them.\n\n${user}`
    const messages = [{ role: 'user', content: images.length ? [...images.map(i => i.block), { type: 'text', text: user }] : user }]
    return { id: c.id, case: c, now: Date.parse(c.at), messages, inputSha256: sha256({ system, messages }), imageEvidence: images.map(i => i.evidence), stockSource: c.stockSnapshot ? 'explicit_regression_fixture' : (c.stock ? 'captured_live_snapshot' : null) }
  })
  return structuredClone({ schemaVersion: 1, capturedAt: new Date(now).toISOString(), configuredModel, usdToInr, source, system, systemSha256: sha256(system), facts, cases: frozenCases, scope: 'Diagnostic regression requests; retrieval examples, buyer profile/order lookups, pre-model routing and the production partial-defer split before language repair are not reproduced. Postguards are a diagnostic subset. Not a population accuracy or voice-fidelity sample.' })
}
export async function prepareReplay(file, { promptSource = 'local', only = [], base = 'https://digital-ketu2-production.up.railway.app' } = {}) {
  const read = readFileSync(join(homedir(), '.dk2_read_token'), 'utf8').trim()
  const api = async path => {
    const response = await fetch(base + path, { method: 'GET', headers: { 'X-DK-Read-Token': read }, signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw Error(`Read-only replay source unavailable (${response.status})`)
    return response.json()
  }
  const [settings, guide, tfRes, catalog] = await Promise.all([
    api('/api/settings'), api('/api/knowledge/chunks?source=STYLE_GUIDE&pageSize=5'),
    api('/api/knowledge/chunks?source=TIMED_FACT&pageSize=8'), getCatalogFacts(),
  ])
  let staticPrompt = promptSource === 'live' ? settings.systemPrompt : (await import('../server/process.js')).DEFAULT_SYSTEM_PROMPT
  const styleGuide = (guide.chunks || guide.items || []).find(c => c.sourceId === 'om_style_guide')
  if (styleGuide) staticPrompt += `\n\nOM'S COMMUNICATION STYLE:\n${styleGuide.content}`
  const cases = JSON.parse(readFileSync(file, 'utf8')).filter(c => !only.length || only.includes(c.id))
  const timedFacts = (tfRes.chunks || tfRes.items || []).map(c => ({ content: c.content }))
  const [stockSnapshot, photoBlock] = await Promise.all([
    cases.some(c => (c.stock || discontinuedSizeRequest(c.msg)) && !c.stockSnapshot) ? getStockSnapshot() : null,
    cases.some(c => c.photo) ? getPhotoIndex().then(formatPhotoBlock) : null,
  ])
  if (!catalog.block || !catalog.products?.length) throw Error('Current catalogue missing; replay refused')
  return freezeReplayInputs({ cases, staticPrompt, catalogBlock: catalog.block, catalogProducts: catalog.products, timedFacts, stockSnapshot, photoBlock,
    configuredModel: resolveReplyModel(settings), usdToInr: settings.usdToInr || 88,
    source: { promptSource, staticPromptSha256: sha256(staticPrompt), catalogueSha256: sha256(catalog), styleGuideSha256: sha256(styleGuide?.content || ''), timedFactsSha256: sha256(timedFacts) } })
}
export function replayRequest(pack, item, model = pack.configuredModel) {
  const body = { ...replyModelParams(model), system: structuredClone(pack.system), messages: structuredClone(item.messages) }
  if (sha256({ system: body.system, messages: body.messages }) !== item.inputSha256) throw Error('Frozen replay inputs changed')
  return body
}
export async function applyReplayGuards(pack, item, rawText) {
  const c = item.case, catalogProducts = pack.facts.catalogProducts, stockSnapshot = pack.facts.stockSnapshot
  let txt = rawText
    // Mirror the production post-model guards (2026-09-09) so a replay judges what the buyer would get.
    {
      txt = canonicalizeCatalogLinks(txt, catalogProducts)
      const gsmHistory = (c.history || []).map(h => ({ buyerMessage: h.buyer, aiReply: h.ai, deferReason: h.manual ? 'manual_reply' : null }))
      txt = customLabelReferralGuard({ buyerText: c.msg, reply: txt, imageUrl: c.imageUrl, english: buyerUsesEnglish({ buyerText: c.msg, history: gsmHistory, preferredLanguage: c.preferredLanguage }) }) || txt
      txt = (!c.imageUrl && regularFitBlueGuard({ products: catalogProducts, buyerText: c.msg, history: (c.history || []).map(h => ({ buyerMessage: h.buyer, aiReply: h.ai, deferReason: h.manual ? 'manual_reply' : null, createdAt: h.at })), now: c.at ? Date.parse(c.at) : item.now, reply: txt, english: buyerUsesEnglish({ buyerText: c.msg, history: gsmHistory, preferredLanguage: c.preferredLanguage }) })) || txt
      txt = gsmPriceRangeGuard({ products: catalogProducts, buyerText: c.msg, history: gsmHistory, reply: txt, imageUrl: c.imageUrl, english: buyerUsesEnglish({ buyerText: c.msg, history: gsmHistory, preferredLanguage: c.preferredLanguage }) }) || txt
      txt = poloRateSummaryGuard({ products: catalogProducts, buyerText: c.msg, history: gsmHistory, reply: txt, english: buyerUsesEnglish({ buyerText: c.msg, history: gsmHistory, preferredLanguage: c.preferredLanguage }) }) || txt
      txt = poloColourQuoteGuard({ products: catalogProducts, buyerText: c.msg, history: gsmHistory, reply: txt, imageUrl: c.imageUrl, english: buyerUsesEnglish({ buyerText: c.msg, history: gsmHistory, preferredLanguage: c.preferredLanguage }) }) || txt
      txt = sublimationPriceGuard({ products: catalogProducts, buyerText: c.msg, history: (c.history || []).map(h => ({ buyerMessage: h.buyer, aiReply: h.ai, deferReason: h.manual ? 'manual_reply' : null, createdAt: h.at })), reply: txt, imageUrl: c.imageUrl, now: item.now }) || txt
      txt = currentBiowashQuoteGuard({ products: catalogProducts, buyerText: c.msg, history: (c.history || []).map(h => ({ buyerMessage: h.buyer, aiReply: h.ai, deferReason: h.manual ? 'manual_reply' : null, isMedia: h.isMedia, createdAt: h.at })), reply: txt, imageUrl: c.imageUrl, now: item.now, english: buyerUsesEnglish({ buyerText: c.msg, history: gsmHistory, preferredLanguage: c.preferredLanguage }) }) || txt
      txt = hoodieRateSummaryGuard({ products: catalogProducts, buyerText: c.msg, history: gsmHistory, reply: txt, english: buyerUsesEnglish({ buyerText: c.msg, history: gsmHistory, preferredLanguage: c.preferredLanguage }) }) || txt
      txt = biowashRateSummaryGuard({ products: catalogProducts, buyerText: c.msg, history: gsmHistory, reply: txt, english: buyerUsesEnglish({ buyerText: c.msg, history: gsmHistory, preferredLanguage: c.preferredLanguage }) }) || txt
      txt = pendingProductChoiceGuard({ buyerText: c.msg, reply: txt, now: c.at ? Date.parse(c.at) : item.now, history: (c.history || []).map(h => ({ buyerMessage: h.buyer, aiReply: h.ai, status: h.manual ? 'SKIPPED' : (h.deferred ? 'DEFERRED' : 'REPLIED'), deferReason: h.manual ? 'manual_reply' : null, createdAt: h.at })) }) || txt
      const discontinuedReply = discontinuedSizeGuard({ buyerText: c.msg, reply: txt, snapshot: c.stockSnapshot || stockSnapshot, now: c.at ? Date.parse(c.at) : item.now })
      if (discontinuedReply) { console.log('   Discontinued-size policy applied'); txt = discontinuedReply }
      txt = stockAlertOfferGuard({ buyerText: c.msg, reply: txt, whatsappNumber: c.whatsappNumber, now: c.at ? Date.parse(c.at) : item.now, english: buyerUsesEnglish({ buyerText: c.msg, history: gsmHistory, preferredLanguage: c.preferredLanguage }), history: (c.history || []).map(h => ({ buyerMessage: h.buyer, aiReply: h.ai, status: h.manual ? 'SKIPPED' : (h.deferred ? 'DEFERRED' : 'REPLIED'), deferReason: h.manual ? 'manual_reply' : null, createdAt: h.at })) }) || txt
      const restockHandoff = restockPointerGuard({ buyerText: c.msg, reply: txt, now: c.at ? Date.parse(c.at) : item.now, history: (c.history || []).map(h => ({ buyerMessage: h.buyer, aiReply: h.ai, status: h.manual ? 'SKIPPED' : (h.deferred ? 'DEFERRED' : 'REPLIED'), deferReason: h.manual ? 'manual_reply' : null, createdAt: h.at })) })
      if (restockHandoff) { console.log('   Restock-pointer guard retained an owner handoff'); txt = restockHandoff }
      const couponHandoff = couponCodeGuard({ buyerText: c.msg, reply: txt, history: (c.history || []).map(h => ({ buyerMessage: h.buyer, aiReply: h.ai, deferReason: h.manual ? 'manual_reply' : null })) })
      if (couponHandoff) { console.log('   Coupon-code guard retained an owner handoff'); txt = couponHandoff }
      const historyText = (c.history || []).map(h => `Buyer: ${h.buyer}\nAssistant: ${h.ai || ''}`).join('\n')
      const g1 = deliveryDaysGuard({ buyerText: c.msg, reply: txt })
      if (g1) { console.log(`   ⚙️ delivery-days guard replaced the model reply`); txt = g1 }
      const g2 = bigBuyerDiscountGuard({ buyerText: c.msg, historyText, reply: txt, english: buyerUsesEnglish({ buyerText: c.msg, history: (c.history || []).map(h => ({ buyerMessage: h.buyer, deferReason: h.manual ? 'manual_reply' : null })) }) })
      if (g2) { console.log(`   ⚙️ discount guard replaced the model reply`); txt = g2 }
      const g3 = arrivalClockGuard({ buyerText: c.msg, reply: txt })
      if (g3) { console.log('   Arrival-clock guard retained a handoff'); txt = g3 }
    }
    txt = (await import('../server/multipart-shipping.js')).multipartShippingGuard({ buyerText: c.msg, reply: txt, imageUrl: c.imageUrl, english: buyerUsesEnglish({ buyerText: c.msg, history: (c.history || []).map(h => ({ buyerMessage: h.buyer, deferReason: h.manual ? 'manual_reply' : null })), preferredLanguage: c.preferredLanguage }) }) || txt
    txt = canonicalizeStockAlertLinks(txt, c.whatsappNumber)

  return txt
}
export function gradeReplay(c, text) {
  return [ ...(c.must || []).filter(m => !new RegExp(m, 'i').test(text)).map(m => `missing /${m}/`), ...(c.mustNot || []).filter(m => new RegExp(m, 'i').test(text)).map(m => `forbidden /${m}/`) ]
}
export async function runReplayCase(pack, item, model, client, { languageRepair = true } = {}) {
  const start = client.records.length
  const response = await client.messages.create(replayRequest(pack, item, model))
  const main = client.records[start]
  let rawText
  try { rawText = responseText(response) } catch (error) {
    return { id: item.id, model, inputSha256: item.inputSha256, ok: false, incomplete: true, fails: [error.code || 'REPLY_INCOMPLETE'], rawText: main.rawText, guardedText: null, finalText: null, calls: client.records.slice(start) }
  }
  const guardedText = await applyReplayGuards(pack, item, rawText)
  let finalText = guardedText, repair = null
  if (languageRepair && !/^\s*\[(DEFER|SKIP)\]\s*$/.test(guardedText)) {
    const c = item.case
    repair = await repairReplyLanguage({ anthropic: client, reply: guardedText, buyerText: c.msg, preferredLanguage: c.preferredLanguage,
      history: (c.history || []).map(h => ({ buyerMessage: h.buyer, deferReason: h.manual ? 'manual_reply' : null })) })
    finalText = repair.reply
  }
  const fails = gradeReplay(item.case, finalText)
  return { id: item.id, model, inputSha256: item.inputSha256, ok: !fails.length, fails, rawText, rawFails: gradeReplay(item.case, rawText), guardedText, finalText, guardChanged: rawText !== guardedText, repair, calls: client.records.slice(start) }
}
export async function replayMain(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { prompt: { type: 'string', default: 'local' }, model: { type: 'string' }, runs: { type: 'string', default: '1' }, only: { type: 'string' }, dump: { type: 'string' }, output: { type: 'string' }, 'budget-inr': { type: 'string', default: '300' } } })
  if (!positionals[0]) throw Error('Usage: node tools/replay.mjs cases.json [--prompt local|live] [--model id] [--dump private-directory]')
  const runs = Number(values.runs)
  if (!Number.isInteger(runs) || runs < 1) throw Error('Invalid runs')
  const pack = await prepareReplay(positionals[0], { promptSource: values.prompt, only: (values.only || '').split(',').filter(Boolean) })
  const output = privateDirectory(values.dump || values.output || join(homedir(), '.local/state/dk2-watch/replays', new Date().toISOString().replaceAll(':', '-')))
  assertFreshReplayOutput(output)
  savePrivate(join(output, 'frozen-inputs.json'), pack)
  if (values.dump) {
    writeFileSync(join(output, 'system.txt'), pack.system.map(b => b.text).join('\n\n'), { mode: 0o600 })
    for (const item of pack.cases) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(item.id)) throw Error('Case ID cannot be used as a dump filename')
      const content = item.messages[0].content
      writeFileSync(join(output, `user_${item.id}.txt`), typeof content === 'string' ? content : content.filter(b => b.type === 'text').map(b => b.text).join('\n'), { mode: 0o600 })
    }
    savePrivate(join(output, 'cases.json'), pack.cases.map(item => item.case))
    console.log(JSON.stringify({ frozen: join(output, 'frozen-inputs.json'), cases: pack.cases.length, configuredModel: pack.configuredModel })); return }
  const { createReplayClient } = await import('./compare-reply-models.mjs')
  const key = process.env.ANTHROPIC_API_KEY || readFileSync(join(homedir(), '.dk2_anthropic_key'), 'utf8').trim()
  const client = createReplayClient({ apiKey: key, budgetInr: Number(values['budget-inr']), exchangeRate: pack.usdToInr, onRecord: () => savePrivate(join(output, 'calls.json'), client.records) })
  const results = []
  try { for (const item of pack.cases) for (let r = 0; r < runs; r++) {
    const result = await runReplayCase(pack, item, values.model || pack.configuredModel, client)
    results.push({ run: r + 1, ...result }); savePrivate(join(output, 'results.json'), { results, costUsd: client.spentUsd })
    console.log(JSON.stringify({ id: item.id, model: result.model, returnedModel: result.calls[0]?.returnedModel, ok: result.ok, costInr: client.spentUsd * pack.usdToInr }))
  } } finally { savePrivate(join(output, 'results.json'), { results, costUsd: client.spentUsd, reservedUsd: client.reservedUsd, complete: results.length === pack.cases.length * runs }) }
  if (results.some(r => !r.ok)) process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) replayMain().catch(error => { console.error(error.code || error.message); process.exitCode = 1 })
