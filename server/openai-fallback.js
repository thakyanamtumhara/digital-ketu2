// OPENAI FALLBACK BRAIN (2026-07-20, Ketu-approved during the Anthropic-credits outage).
// Claude Opus 4.8 stays PRIMARY (it's the more-faithful clone). This is ONLY invoked when the
// Anthropic reply call fails with a credit/billing/auth-suspension error, so the shop never goes
// fully dark during an Anthropic outage. Reuses the SAME OPENAI_API_KEY already configured for
// Whisper transcription. Same 24K rulebook + catalog + per-query prompt → a degraded but on-brand
// reply. Auto-reverts to Claude the moment Anthropic credits return (this path just isn't hit).
//
// Honest limitation: GPT-4o follows the Claude-tuned rulebook differently — voice/edge-cases won't
// match Ketu as tightly as Claude. It is a SAFETY NET, not a replacement.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
// gpt-4o-mini is the default: in testing it held EVERY key rule (complaint→defer, stock→defer,
// discount→"Fixed price", MOQ line, full address) and, unlike gpt-4o (30K TPM on this key → ~1
// reply/min with our 24K-word rulebook), it has the throughput + low cost (~₹0.4/reply) to cover a
// busy hour during an Anthropic outage. Override with OPENAI_FALLBACK_MODEL if ever needed.
const FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini'
// per-M in/out USD by model family (mini is ~1/16th of 4o)
const PRICES = { 'gpt-4o-mini': [0.15, 0.60], 'gpt-4o': [2.5, 10] }
const [OAI_PRICE_IN, OAI_PRICE_OUT] = (PRICES[FALLBACK_MODEL] || PRICES['gpt-4o-mini']).map(p => p / 1_000_000)

export function isOpenAiFallbackConfigured() {
  return !!OPENAI_API_KEY
}

// Build OpenAI chat messages from the SAME pieces the Claude path uses.
function toOpenAiMessages(systemText, userText, imageBlock) {
  const userContent = []
  if (userText) userContent.push({ type: 'text', text: userText })
  if (imageBlock?.source?.data) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${imageBlock.source.media_type || 'image/jpeg'};base64,${imageBlock.source.data}` },
    })
  }
  return [
    { role: 'system', content: systemText },
    { role: 'user', content: userContent.length === 1 && userContent[0].type === 'text' ? userText : userContent },
  ]
}

// Returns { reply, costUsd, model } on success, or null on any failure (caller then logs FAILED).
export async function openaiReply({ systemText, userText, imageBlock }) {
  if (!OPENAI_API_KEY) return null
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: FALLBACK_MODEL,
        max_tokens: 500,
        messages: toOpenAiMessages(systemText, userText, imageBlock),
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[OpenAI-Fallback] ${res.status}: ${body.slice(0, 160)}`)
      return null
    }
    const d = await res.json()
    const reply = (d.choices?.[0]?.message?.content || '').trim()
    if (!reply) return null
    const u = d.usage || {}
    const costUsd = (u.prompt_tokens || 0) * OAI_PRICE_IN + (u.completion_tokens || 0) * OAI_PRICE_OUT
    return { reply, costUsd, model: d.model || FALLBACK_MODEL }
  } catch (err) {
    console.error('[OpenAI-Fallback] call failed:', err?.message)
    return null
  }
}
