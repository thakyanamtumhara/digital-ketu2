export const BASELINE_REPLY_MODEL = 'claude-opus-5'

const labels = Object.freeze({
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-fable-5-1': 'Fable 5.1',
})

export const REPLY_MODEL_INFO = Object.freeze({
  allow: Object.freeze(Object.keys(labels)),
  default: BASELINE_REPLY_MODEL,
  labels,
})

export function baseModelId(model) {
  return typeof model === 'string' ? model.replace(/-\d{8}$/, '') : ''
}

export function validReplyModelId(model) {
  return typeof model === 'string' && model.length <= 100 && model === model.trim() && /^claude-[a-z][a-z0-9-]*$/.test(model)
}

export function resolveReplyModel(settings) {
  return validReplyModelId(settings?.replyModel) ? settings.replyModel : BASELINE_REPLY_MODEL
}

export function replyModelParams(model, { maxTokens } = {}) {
  if (!validReplyModelId(model)) throw new Error('Invalid reply model ID')
  const legacy = ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7'].includes(baseModelId(model))
  const max_tokens = maxTokens ?? (legacy ? 500 : 4096)
  if (!Number.isSafeInteger(max_tokens) || max_tokens <= 0) throw new Error('Invalid reply output token limit')
  return legacy
    ? { model, max_tokens, thinking: { type: 'disabled' } }
    : { model, max_tokens, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }
}

export function responseText(response) {
  if (response?.stop_reason !== 'end_turn') {
    const error = new Error('Reply response did not finish with end_turn')
    error.code = 'REPLY_INCOMPLETE'
    throw error
  }
  const text = (Array.isArray(response.content) ? response.content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').trim()
  if (!text) {
    const error = new Error('Reply response contained no buyer text')
    error.code = 'REPLY_EMPTY'
    throw error
  }
  return text
}

const knownRates = Object.freeze({
  'claude-opus-5-5': [4, 20, 0.20],
  'claude-opus-5': [5, 25, 0.50],
  'claude-opus-4-8': [5, 25, 0.50],
  'claude-opus-4-7': [5, 25, 0.50],
  'claude-fable-5-1': [10, 50, 0.25],
})

export function modelPricing(model) {
  const id = baseModelId(model)
  const known = Object.hasOwn(knownRates, id)
  const [inputPerMTok, outputPerMTok, cacheReadPerMTok] = known ? knownRates[id] : [10, 50, 1]
  return {
    model: id,
    label: labels[id] || String(model || 'Unknown model'),
    currency: 'USD',
    unit: 'MTok',
    inputPerMTok,
    outputPerMTok,
    cacheWrite5mPerMTok: inputPerMTok * 1.25,
    cacheWrite1hPerMTok: inputPerMTok * 2,
    cacheReadPerMTok,
    verified: known,
    estimated: !known,
  }
}

function tokens(value) {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid reply usage token count')
  return value
}

export function modelUsageCost(model, usage = {}, { oneHour = false } = {}) {
  const rates = modelPricing(model)
  const inputTokens = tokens(usage.input_tokens)
  const outputTokens = tokens(usage.output_tokens)
  const cacheReadTokens = tokens(usage.cache_read_input_tokens)
  const aggregate = tokens(usage.cache_creation_input_tokens)
  const detail = usage.cache_creation
  const has5m = detail != null && Object.hasOwn(detail, 'ephemeral_5m_input_tokens')
  const has1h = detail != null && Object.hasOwn(detail, 'ephemeral_1h_input_tokens')
  let cacheWrite5mTokens, cacheWrite1hTokens
  if (has5m || has1h) {
    cacheWrite5mTokens = tokens(detail.ephemeral_5m_input_tokens)
    cacheWrite1hTokens = tokens(detail.ephemeral_1h_input_tokens)
    if (usage.cache_creation_input_tokens !== undefined) {
      const remaining = aggregate - cacheWrite5mTokens - cacheWrite1hTokens
      if (remaining < 0 || (has5m && has1h && remaining !== 0)) throw new Error('Inconsistent reply cache usage')
      if (!has5m) cacheWrite5mTokens += remaining
      if (!has1h) cacheWrite1hTokens += remaining
    }
  } else {
    cacheWrite5mTokens = oneHour ? 0 : aggregate
    cacheWrite1hTokens = oneHour ? aggregate : 0
  }
  const costUsd = (
    inputTokens * rates.inputPerMTok + outputTokens * rates.outputPerMTok
    + cacheReadTokens * rates.cacheReadPerMTok
    + cacheWrite5mTokens * rates.cacheWrite5mPerMTok
    + cacheWrite1hTokens * rates.cacheWrite1hPerMTok
  ) / 1_000_000
  return { costUsd, estimated: rates.estimated, rates, inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens }
}
