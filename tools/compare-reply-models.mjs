import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { modelPricing, modelUsageCost, baseModelId } from '../server/reply-models.js'
import { prepareReplay, privateDirectory, savePrivate, sha256, runReplayCase, assertFreshReplayOutput } from './replay.mjs'

const HAIKU = 'claude-haiku-4-5'
function ratesFor(model) {
  if (baseModelId(model) !== HAIKU) return modelPricing(model)
  return { model: HAIKU, verified: true, estimated: false, inputPerMTok: 1, outputPerMTok: 5, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2, cacheReadPerMTok: 0.1 }
}
export function replayUsageCost(model, usage, oneHour) {
  if (baseModelId(model) !== HAIKU) return modelUsageCost(model, usage, { oneHour })
  const buckets = modelUsageCost('claude-opus-5', usage, { oneHour })
  return { ...buckets, rates: ratesFor(model), estimated: false, costUsd: buckets.costUsd / 5 }
}
export function createReplayClient({ apiKey, budgetInr, exchangeRate = 88, fetchImpl = fetch, onRecord = () => {} }) {
  if (!Number.isFinite(budgetInr) || !Number.isFinite(exchangeRate) || !(budgetInr > 0) || !(exchangeRate > 0)) throw Error('A finite positive replay budget and exchange rate are required')
  const records = []
  let spentUsd = 0, reservedUsd = 0, halted = false
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'extended-cache-ttl-2025-04-11', 'content-type': 'application/json' }
  const client = {
    records,
    get spentUsd() { return spentUsd },
    get reservedUsd() { return reservedUsd },
    get halted() { return halted },
    messages: { create: async body => {
      if (halted) throw Object.assign(Error('Replay halted after an uncertain request; no automatic retry'), { code: 'REPLAY_HALTED' })
      const rates = ratesFor(body.model)
      if (!rates.verified) throw Object.assign(Error('Verify model prices before budgeted replay'), { code: 'UNVERIFIED_PRICE' })
      const { max_tokens, ...countBody } = body
      if (!Number.isSafeInteger(max_tokens) || max_tokens <= 0) throw Error('A finite positive output-token limit is required')
      const countResponse = await fetchImpl('https://api.anthropic.com/v1/messages/count_tokens', {
        method: 'POST', headers, body: JSON.stringify(countBody), signal: AbortSignal.timeout(30000),
      })
      if (!countResponse.ok) throw Object.assign(Error('Token-count preflight failed; inference not sent'), { code: 'TOKEN_COUNT_FAILED' })
      const count = (await countResponse.json()).input_tokens
      if (!Number.isSafeInteger(count) || count < 0) throw Error('Invalid token-count preflight')
      const inputBound = Math.ceil(count * 1.1) + 256
      const oneHour = (body.system || []).some(block => block.cache_control?.ttl === '1h')
      const inputRate = oneHour ? Math.max(rates.inputPerMTok, rates.cacheWrite1hPerMTok) : Math.max(rates.inputPerMTok, rates.cacheWrite5mPerMTok)
      const reserve = (inputBound * inputRate + max_tokens * rates.outputPerMTok) / 1e6
      if ((spentUsd + reservedUsd + reserve) * exchangeRate > budgetInr) {
        throw Object.assign(Error('Remaining budget cannot cover a conservative complete request'), { code: 'REPLAY_BUDGET_STOP' })
      }
      const record = { at: new Date().toISOString(), requestedModel: body.model, requestedParams: { max_tokens, thinking: body.thinking, output_config: body.output_config },
        requestSha256: sha256(body), inputSha256: sha256({ system: body.system, messages: body.messages }), countedInputTokens: count,
        maximumReservedUsd: reserve, status: 'in_flight', returnedModel: null, responseId: null, requestId: null, costUsd: null }
      records.push(record); reservedUsd += reserve; onRecord(record)
      const started = performance.now()
      try {
        const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
        })
        record.latencyMs = Math.round(performance.now() - started)
        record.httpStatus = response.status
        record.requestId = response.headers?.get('request-id') || null
        const result = await response.json()
        record.responseId = result.id || null
        record.returnedModel = result.model || null
        record.stopReason = result.stop_reason || null
        record.rawText = (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
        record.contentTypes = (result.content || []).map(block => block.type)
        if (!response.ok || !result.usage || !Number.isSafeInteger(result.usage.output_tokens)) throw Object.assign(Error('Inference response has no confirmed usage; budget remains reserved'), { code: 'REPLAY_USAGE_UNCERTAIN' })
        const costModel = result.model || body.model
        if (!ratesFor(costModel).verified) throw Object.assign(Error('Returned model has unverified rates'), { code: 'REPLAY_USAGE_UNCERTAIN' })
        const usageCost = replayUsageCost(costModel, result.usage, oneHour)
        record.usage = result.usage; record.cost = usageCost; record.costUsd = usageCost.costUsd
        spentUsd += usageCost.costUsd; reservedUsd -= reserve; record.status = 'received'
        const datedRequest = baseModelId(body.model) !== body.model
        record.returnedIdentityVerified = typeof result.model === 'string' && (datedRequest ? result.model === body.model : baseModelId(result.model) === body.model)
        if (usageCost.costUsd > reserve || spentUsd * exchangeRate > budgetInr) {
          halted = true; record.budgetEstimateExceeded = true
        }
        onRecord(record)
        if (!record.returnedIdentityVerified) throw Object.assign(Error('Returned model does not verify requested model identity'), { code: 'REPLAY_MODEL_MISMATCH' })
        return result
      } catch (error) {
        halted = true; record.status = record.costUsd === null ? 'uncertain' : 'rejected'; record.errorCode = error.code || error.name; onRecord(record)
        throw error
      }
    } },
  }
  return client
}

export async function compareMain(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    output: { type: 'string' }, frozen: { type: 'string' }, prompt: { type: 'string', default: 'local' },
    models: { type: 'string', default: 'claude-opus-5,claude-opus-5-5' }, 'budget-inr': { type: 'string', default: '280' },
    'freeze-only': { type: 'boolean', default: false },
  } })
  if (!values.output || (!values.frozen && !positionals[0])) throw Error('Usage: node tools/compare-reply-models.mjs cases.json --output private-dir [--freeze-only] [--frozen saved-inputs.json]')
  const output = privateDirectory(values.output)
  assertFreshReplayOutput(output)
  const pack = values.frozen ? JSON.parse(readFileSync(values.frozen, 'utf8')) : await prepareReplay(positionals[0], { promptSource: values.prompt })
  savePrivate(join(output, 'frozen-inputs.json'), pack)
  if (values['freeze-only']) { console.log(JSON.stringify({ output, cases: pack.cases.length, configuredModel: pack.configuredModel, frozen: true })); return }
  const models = values.models.split(',').map(m => m.trim()).filter(Boolean)
  if (models.length !== 2 || new Set(models).size !== 2) throw Error('Comparison requires two different models')
  const key = process.env.ANTHROPIC_API_KEY || readFileSync(join(homedir(), '.dk2_anthropic_key'), 'utf8').trim()
  const client = createReplayClient({ apiKey: key, budgetInr: Number(values['budget-inr']), exchangeRate: pack.usdToInr,
    onRecord: () => savePrivate(join(output, 'calls.json'), client.records) })
  const report = { at: new Date().toISOString(), models, cases: pack.cases.map(c => c.id), frozenSha256: sha256(pack),
    budgetInr: Number(values['budget-inr']), usdToInr: pack.usdToInr, results: [], complete: false,
    scope: 'Fixed diagnostic cases with identical frozen facts and media. Compatibility settings differ by model. Raw and guarded outputs are separate; no overall voice or fidelity claim.' }
  const save = () => savePrivate(join(output, 'comparison.json'), { ...report, costUsd: client.spentUsd, costInr: client.spentUsd * pack.usdToInr, uncertainReservedUsd: client.reservedUsd })
  try {
    for (const item of pack.cases) for (const model of models) {
      const result = await runReplayCase(pack, item, model, client)
      report.results.push(result); save()
      console.log(JSON.stringify({ id: item.id, requested: model, returned: result.calls[0]?.returnedModel, ok: result.ok, rawPass: !result.incomplete && !result.rawFails?.length, guardChanged: result.guardChanged, costInr: client.spentUsd * pack.usdToInr }))
      if (client.halted) throw Object.assign(Error('Budget estimate exceeded; stopped'), { code: 'REPLAY_HALTED' })
    }
    report.complete = true
  } catch (error) { report.stopped = error.code || error.name; process.exitCode = 1 }
  finally { save() }
  console.log(JSON.stringify({ output, complete: report.complete, results: report.results.length, costInr: client.spentUsd * pack.usdToInr, stopped: report.stopped }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) compareMain().catch(error => { console.error(error.code || error.message); process.exitCode = 1 })
