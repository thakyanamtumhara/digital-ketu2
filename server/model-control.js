import { REPLY_MODEL_INFO, baseModelId, validReplyModelId, resolveReplyModel, replyModelParams, responseText, modelUsageCost, modelPricing } from './reply-models.js'

const knownOlder = new Set(['claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4-0', 'claude-opus-4', 'claude-3-opus', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-0', 'claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-sonnet', 'claude-haiku-4-5', 'claude-3-5-haiku', 'claude-3-haiku'])
const label = id => REPLY_MODEL_INFO.labels[baseModelId(id)] || String(id).replace(/^claude-/, '').replace(/-/g, ' ')
const error = (message, status = 400) => Object.assign(new Error(message), { status })
const matchesModel = (requested, actual) => validReplyModelId(actual) && (requested === baseModelId(requested) ? baseModelId(actual) === requested : actual === requested)

export function modelEligibility(model) {
  if (!model || !validReplyModelId(model.id)) return 'This model is not available on the account.'
  if (REPLY_MODEL_INFO.allow.includes(baseModelId(model.id))) return null
  const caps = model.capabilities
  if (!caps?.image_input?.supported || !caps?.thinking?.types?.adaptive?.supported || !caps?.effort?.low?.supported) return 'The API has not confirmed compatible image and reasoning support.'
  return null
}

export function publicModelUse(row) {
  const use = row?.modelUse
  if (use?.outputSource === 'rule' || !validReplyModelId(use?.responseModel)) return null
  const requestedModel = validReplyModelId(use.requestedModel) ? use.requestedModel : null
  const rewriteModel = use.rewrite?.changed && validReplyModelId(use.rewrite.responseModel) ? use.rewrite.responseModel : null
  return { model: use.responseModel, label: label(use.responseModel), requestedModel, at: row.createdAt, fallback: Boolean(use.fallback), rewriteModel }
}

export function assessModelOutput(rows, model) {
  const matching = rows.filter(row => row.modelUse?.outputSource !== 'rule' && matchesModel(model, row.modelUse?.responseModel))
  const leakDeferrals = matching.filter(row => row.status === 'DEFERRED' && row.deferReason === 'reasoning_leak_blocked').length
  const allReplies = matching.filter(row => row.status === 'REPLIED' && row.sentViaWwbun && row.costUsd > 0)
  const replies = allReplies.slice(0, 30)
  const lengths = replies.map(row => String(row.aiReply || '').replace(/https?:\/\/\S+/g, '').trim().split(/\s+/).filter(Boolean).length)
  const avgWords = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0
  const longFrac = lengths.length ? lengths.filter(n => n > 120).length / lengths.length : 0
  const leakSpike = leakDeferrals >= 4 && leakDeferrals / (leakDeferrals + allReplies.length) >= 0.2
  return { leakDeferrals, replies: replies.length, avgWords, longFrac, revert: leakSpike || (replies.length >= 8 && avgWords >= 70) || (replies.length >= 12 && longFrac >= 0.5) }
}

export function createModelControl({ db, anthropic, onSwitch = () => {}, now = () => Date.now() }) {
  let catalog = { at: 0, models: [] }, catalogError = null, switching = false, verification = null
  async function models(refresh = false) {
    if (!refresh && catalog.models.length && now() - catalog.at < 15 * 60_000) return catalog.models
    try {
      const rows = []
      for await (const model of anthropic.models.list({ limit: 100 }, { timeout: 15_000, maxRetries: 0 })) if (validReplyModelId(model.id)) rows.push(model)
      if (!rows.length) throw new Error('empty catalogue')
      catalog = { at: now(), models: rows }; catalogError = null
    } catch {
      catalogError = 'Model availability could not be refreshed.'
    }
    return catalog.models
  }
  async function state(refresh = false) {
    const live = await models(refresh)
    const settings = await db.settings.findUnique({ where: { id: 'default' } })
    const current = resolveReplyModel(settings)
    const currentSource = live.find(m => matchesModel(current, m.id))
    const choices = new Map()
    for (const id of REPLY_MODEL_INFO.allow) {
      const source = live.find(m => baseModelId(m.id) === id)
      choices.set(source?.id || id, source || { id })
    }
    for (const m of live) if (!knownOlder.has(baseModelId(m.id))) choices.set(m.id, m)
    if (![...choices.values()].some(m => matchesModel(current, m.id))) choices.set(current, { id: current })
    const available = [...choices.values()].map(m => {
      const listed = live.some(x => x.id === m.id)
      const reason = !listed ? 'Not currently listed by the provider.' : modelEligibility(m)
      return { id: m.id, label: label(m.id), current: matchesModel(current, m.id), newer: Boolean(currentSource && new Date(m.created_at) > new Date(currentSource.created_at)), live: listed && !catalogError, selectable: listed && !catalogError && !reason, reason: catalogError || reason, pricing: modelPricing(m.id) }
    })
    let lastReply = null, statusStale = false
    try {
      const rows = await db.$queryRawUnsafe(`SELECT "createdAt", "promptSent"->'modelUse' AS "modelUse" FROM "MessageLog" WHERE status = 'REPLIED' AND "sentViaWwbun" = true AND "costUsd" > 0 AND "promptSent"->'modelUse'->>'outputSource' IS DISTINCT FROM 'rule' ORDER BY "createdAt" DESC LIMIT 1`)
      lastReply = publicModelUse(rows[0])
    } catch { statusStale = true }
    const newerAvailable = available.filter(m => m.newer && m.live)
    const detectedNew = catalogError ? [] : live.filter(m => !knownOlder.has(baseModelId(m.id)) && !REPLY_MODEL_INFO.allow.includes(baseModelId(m.id)) && baseModelId(m.id) !== baseModelId(current)).map(m => m.id)
    const currentVerification = verification && matchesModel(current, verification.model) && Date.parse(verification.at) === new Date(settings?.replyModelSetAt).getTime() ? verification : null
    return { current, currentLabel: label(current), currentSetAt: settings?.replyModelSetAt || null, currentPricing: modelPricing(current), available, newerAvailable, detectedNew, badge: newerAvailable.length > 0 || detectedNew.length > 0, checkedAt: new Date(now()).toISOString(), catalogCheckedAt: catalog.at ? new Date(catalog.at).toISOString() : null, catalogStale: Boolean(catalogError), statusStale, lastReply, verification: currentVerification }
  }
  async function switchTo(model) {
    if (switching) throw error('Another model switch is being checked. Please wait.', 409)
    switching = true
    try {
      if (!validReplyModelId(model)) throw error('Choose a model from the available list.')
      const live = await models(true)
      if (catalogError) throw error('Availability check failed. Your selected model was not changed.', 502)
      const found = live.find(m => m.id === model || baseModelId(m.id) === model)
      const reason = modelEligibility(found)
      if (reason) throw error(reason)
      const before = await db.settings.findUnique({ where: { id: 'default' } })
      if (!before) throw error('Reply settings are unavailable.', 503)
      let response
      try {
        response = await anthropic.messages.create({ ...replyModelParams(model), system: 'This is a technical compatibility check. Reply with exactly READY.', messages: [{ role: 'user', content: 'Confirm readiness.' }] }, { timeout: 40_000, maxRetries: 0 })
      } catch { throw error('The model failed its API test. Your selected model was not changed.', 502) }
      const usage = modelUsageCost(response.model || model, response.usage || {})
      await db.settings.update({ where: { id: 'default' }, data: { dailyJobSpentUsd: { increment: usage.costUsd } } })
      let text
      try { text = responseText(response) } catch { throw error('The model returned an incomplete test answer. Your selected model was not changed.', 502) }
      const modelMatches = matchesModel(model, response.model)
      if (!modelMatches || !/^READY[.!]?$/i.test(text.trim())) throw error('The returned model or test answer did not match. Your selected model was not changed.', 502)
      const changedAt = new Date(now())
      const changed = await db.settings.updateMany({ where: { id: 'default', replyModel: before.replyModel, replyModelSetAt: before.replyModelSetAt }, data: { replyModel: model, replyModelSetAt: changedAt } })
      if (changed.count !== 1) throw error('The selection changed during the test. Refresh before switching again.', 409)
      verification = { model: response.model, at: changedAt.toISOString(), status: 'api_test_passed' }
      onSwitch()
      return { ok: true, model, label: label(model), verifiedModel: response.model, verifiedAt: verification.at }
    } finally { switching = false }
  }
  return { state, switchTo }
}
