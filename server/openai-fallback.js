// OPENAI FALLBACK BRAIN (2026-07-20, Ketu-approved during the Anthropic-credits outage; upgraded
// same day to a Sonnet-category tier at Ketu's request). Claude Opus 4.8 stays PRIMARY (the most
// faithful clone). This is invoked ONLY when the Anthropic reply call fails with a credit/billing/
// auth error, so the shop never goes fully dark. Reuses the OPENAI_API_KEY already configured for
// Whisper transcription. Auto-reverts to Claude the moment Anthropic credits return.
//
// TWO-TIER (Ketu 2026-07-20 "reply like a sonnet category"): try gpt-4.1 first — full Sonnet-grade,
// but ~30K TPM on this key means the big 24K-word rulebook caps it at ~1 reply/min; on a rate-limit
// (429) it drops to gpt-4.1-mini, a near-Sonnet mini-class model with high throughput that (tested)
// holds every key rule. So every reply is Sonnet-category; bursts never choke. Both far above the
// old gpt-4o-mini. Override the chain with OPENAI_FALLBACK_MODELS (comma-separated, best-first).

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const FALLBACK_MODELS = (process.env.OPENAI_FALLBACK_MODELS || 'gpt-4.1,gpt-4.1-mini')
  .split(',').map(m => m.trim()).filter(Boolean)
// per-M [input, output] USD by model
const PRICES = {
  'gpt-4.1': [2.0, 8.0], 'gpt-4.1-mini': [0.4, 1.6], 'gpt-4.1-nano': [0.1, 0.4],
  'gpt-4o': [2.5, 10.0], 'gpt-4o-mini': [0.15, 0.60],
}
function priceOf(model) {
  // Match the LONGEST key first — "gpt-4.1-mini-2025-04-14" must hit 'gpt-4.1-mini', NOT 'gpt-4.1'
  // (which is a prefix of it and would 5× the cost, draining the budget + false-tripping the alarm).
  const key = Object.keys(PRICES).sort((a, b) => b.length - a.length).find(k => model.startsWith(k)) || 'gpt-4.1-mini'
  return PRICES[key].map(p => p / 1_000_000)
}

export function isOpenAiFallbackConfigured() {
  return !!OPENAI_API_KEY
}

// GPT-specific guardrails — the Opus-vs-mini head-to-head (2026-07-20) showed small OpenAI models'
// real slips vs Opus were: (a) fabricating stock ("out lag raha hai"/"available nahi") instead of
// deferring, (b) inventing a phone/vendor/referral number, (c) being wordier than Ketu. Prepend a
// sharp override that hits exactly those. Kept for all fallback models (harmless for the bigger ones).
const MINI_GUARDRAILS = `⚠️ CRITICAL OVERRIDES — these win over anything below that conflicts:
1. You do NOT know live stock — EXCEPT when the request contains a "📦 LIVE STOCK DATA" block: that block is live and trusted, answer stock questions FROM it per its rules. WITHOUT that block: NEVER say a product/size/colour is "out of stock" / "out lag raha hai" / "available nahi hai", and never assert it IS in stock. For ANY "is X in stock / available hai / kab aayega / restock" question with no block, reply EXACTLY: Ketu will reply shortly sir 🙏
2. NEVER invent or send a phone number, WhatsApp number, vendor, or referral link that is not written verbatim in your instructions below. If a product/size isn't something we make, say we don't make it and point to https://sale91.com/catalog — do NOT route to a made-up vendor.
3. Reply in ONE short line, in Ketu's terse Hinglish voice (match the buyer's language). No multi-sentence sales pitches.
4. A bare "haan / ha / ok / theek hai / bata deti hu" is NOT new order details or a fresh instruction — do NOT start or RE-OPEN a "kya add karna hai? product/colour/size batao" interrogation on it, and do NOT repeat a question you already asked. If the recent conversation shows a delivery complaint / return / refund / an order change, or looks like the human owner is already handling it, reply EXACTLY: Ketu will reply shortly sir 🙏
`

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
    { role: 'system', content: MINI_GUARDRAILS + '\n' + systemText },
    { role: 'user', content: userContent.length === 1 && userContent[0].type === 'text' ? userText : userContent },
  ]
}

// One model attempt. Returns { reply, costUsd, model } on success, 'RATELIMIT' on 429 (→ try next
// tier), or null on any other failure.
async function tryModel(model, messages) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 500, messages }),
      signal: AbortSignal.timeout(30000),
    })
    if (res.status === 429) { console.warn(`[OpenAI-Fallback] ${model} rate-limited → next tier`); return 'RATELIMIT' }
    if (!res.ok) {
      console.error(`[OpenAI-Fallback] ${model} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 140)}`)
      return null
    }
    const d = await res.json()
    const reply = (d.choices?.[0]?.message?.content || '').trim()
    if (!reply) return null
    const u = d.usage || {}
    const [pin, pout] = priceOf(model)
    return { reply, costUsd: (u.prompt_tokens || 0) * pin + (u.completion_tokens || 0) * pout, model: d.model || model }
  } catch (err) {
    console.error(`[OpenAI-Fallback] ${model} call failed:`, err?.message)
    return null
  }
}

// Walk the tier chain (best model first). Returns { reply, costUsd, model } or null.
export async function openaiReply({ systemText, userText, imageBlock }) {
  if (!OPENAI_API_KEY) return null
  const messages = toOpenAiMessages(systemText, userText, imageBlock)
  for (const model of FALLBACK_MODELS) {
    const out = await tryModel(model, messages)
    if (out && out !== 'RATELIMIT') return out
    // RATELIMIT or null → fall through to the next (cheaper/higher-throughput) tier
  }
  return null
}
