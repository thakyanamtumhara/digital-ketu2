// Audio transcription — converts WhatsApp voice notes into text so downstream
// pipeline can treat them as normal buyer messages (answer) or Om replies (learn).
//
// Provider selection via TRANSCRIPTION_PROVIDER env var:
//   "groq"    (default) — Whisper-v3 via Groq, OpenAI-compatible API, ~$0.00011/min, ~500ms latency
//   "openai"  — official Whisper-1, ~$0.006/min, slower but well-trusted
//   "sarvam"  — Hindi-first Indian API, best Hinglish quality, ~₹0.30/min
//
// Returns { text, provider, costUsd, durationMs } on success, or null on failure.
// Callers should fall back to the existing media_only auto-reply when null.

const PROVIDER = (process.env.TRANSCRIPTION_PROVIDER || 'groq').toLowerCase()
const GROQ_API_KEY = process.env.GROQ_API_KEY
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const SARVAM_API_KEY = process.env.SARVAM_API_KEY

export function isTranscriptionConfigured() {
  if (PROVIDER === 'groq') return !!GROQ_API_KEY
  if (PROVIDER === 'openai') return !!OPENAI_API_KEY
  if (PROVIDER === 'sarvam') return !!SARVAM_API_KEY
  return false
}

export function getTranscriptionProvider() {
  return PROVIDER
}

// Minimum transcript length (characters) to accept. Below this we treat it as
// a failure (empty/garbled audio) and fall back to the media_only reply.
const MIN_TRANSCRIPT_LENGTH = 3

const PROVIDER_KEYS = { groq: GROQ_API_KEY, openai: OPENAI_API_KEY, sarvam: SARVAM_API_KEY }

// Providers to try, in order: the env-configured one first, then any others whose API key is set.
// This makes transcription RESILIENT — if the primary provider fails (Sarvam out of credits, an
// outage, a bad key), it automatically falls back to a working one instead of silently dropping the
// voice note. A single dead provider is exactly what broke transcription before, so this chain —
// not just swapping one provider for another — is the durable fix.
function providerOrder() {
  return [...new Set([PROVIDER, 'openai', 'groq', 'sarvam'])].filter(p => PROVIDER_KEYS[p])
}

async function runProvider(p, audioBuffer) {
  if (p === 'groq') return transcribeViaGroq(audioBuffer)
  if (p === 'openai') return transcribeViaOpenAI(audioBuffer)
  if (p === 'sarvam') return transcribeViaSarvam(audioBuffer)
  return null
}

export async function transcribeAudio(mediaUrl) {
  if (!mediaUrl) return null
  const providers = providerOrder()
  if (!providers.length) {
    console.log('[Transcribe] no provider API key configured — skipping')
    return null
  }

  const startTime = Date.now()
  let audioBuffer
  try {
    // Download the audio bytes once (reused across provider attempts).
    const audioRes = await fetch(mediaUrl)
    if (!audioRes.ok) {
      console.error(`[Transcribe] Audio fetch failed: ${audioRes.status} ${audioRes.statusText}`)
      return null
    }
    audioBuffer = await audioRes.arrayBuffer()
    if (audioBuffer.byteLength < 1000) {
      console.log(`[Transcribe] Audio too small (${audioBuffer.byteLength}B) — skipping`)
      return null
    }
  } catch (err) {
    console.error('[Transcribe] audio fetch error:', err.message)
    return null
  }

  // Try each provider in order; return the first usable transcript (fall back on any failure).
  for (const p of providers) {
    try {
      const result = await runProvider(p, audioBuffer)
      if (result && result.text && result.text.trim().length >= MIN_TRANSCRIPT_LENGTH) {
        const durationMs = Date.now() - startTime
        console.log(`[Transcribe] ${p} → "${result.text.substring(0, 80)}${result.text.length > 80 ? '…' : ''}" (${durationMs}ms)`)
        return { text: result.text.trim(), provider: p, costUsd: result.costUsd || 0, durationMs }
      }
      console.log(`[Transcribe] ${p} returned empty/too-short — trying next provider`)
    } catch (err) {
      console.error(`[Transcribe] ${p} failed (${err.message}) — trying next provider`)
    }
  }
  console.log('[Transcribe] all providers failed — using media_only reply')
  return null
}

// Diagnostic variant: same steps as transcribeAudio but returns a structured
// report (HTTP statuses, byte size, provider error body) instead of swallowing
// failures to null. Used by the /api/debug/transcribe-test endpoint to find why
// voice notes fail. The provider functions throw "Groq API <status>: <body>" on
// error, so err.message carries the exact reason.
export async function transcribeAudioDebug(mediaUrl) {
  const out = { configuredProvider: PROVIDER, providersToTry: providerOrder() }
  if (!mediaUrl) { out.error = 'no mediaUrl'; return out }
  if (!out.providersToTry.length) { out.error = 'no provider API key configured'; return out }
  try {
    const audioRes = await fetch(mediaUrl)
    out.audioFetchStatus = audioRes.status
    out.audioContentType = audioRes.headers.get('content-type')
    if (!audioRes.ok) { out.error = `audio fetch failed: ${audioRes.status}`; return out }
    const buf = await audioRes.arrayBuffer()
    out.audioBytes = buf.byteLength
    if (buf.byteLength < 1000) { out.error = `audio too small (${buf.byteLength}B)`; return out }
    out.attempts = []
    for (const p of out.providersToTry) {
      try {
        const r = await runProvider(p, buf)
        if (r && r.text && r.text.trim().length >= MIN_TRANSCRIPT_LENGTH) {
          out.providerUsed = p
          out.transcript = r.text.trim()
          out.ok = true
          return out
        }
        out.attempts.push({ provider: p, result: 'empty/too-short' })
      } catch (e) {
        out.attempts.push({ provider: p, error: (e.message || '').slice(0, 160) })
      }
    }
    out.ok = false
    out.error = 'all providers failed'
  } catch (err) {
    out.error = err.message
  }
  return out
}

// ------------------------------------------------------------------
// Provider: Groq Whisper-large-v3-turbo (OpenAI-compatible API)
// ------------------------------------------------------------------
async function transcribeViaGroq(audioBuffer) {
  const form = new FormData()
  form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg')
  form.append('model', 'whisper-large-v3-turbo')
  form.append('response_format', 'json')
  // Leave language unset so Whisper auto-detects Hindi/English/Hinglish switching

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: form,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Groq API ${res.status}: ${errText.substring(0, 200)}`)
  }
  const data = await res.json()
  // Groq whisper-large-v3-turbo is ~$0.04 / hour audio = $0.00067/min
  // We don't know exact duration without extra work; rough estimate by bytes (not exact).
  return { text: data.text || '', costUsd: 0.001 }  // rough per-call estimate for logging
}

// ------------------------------------------------------------------
// Provider: OpenAI Whisper-1
// ------------------------------------------------------------------
async function transcribeViaOpenAI(audioBuffer) {
  const form = new FormData()
  form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg')
  form.append('model', 'whisper-1')
  form.append('response_format', 'json')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: form,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`OpenAI API ${res.status}: ${errText.substring(0, 200)}`)
  }
  const data = await res.json()
  return { text: data.text || '', costUsd: 0.003 }  // ~$0.006/min, rough per-call estimate
}

// ------------------------------------------------------------------
// Provider: Sarvam AI (Hindi-first, Indian)
// ------------------------------------------------------------------
// Docs: https://docs.sarvam.ai/api-reference-docs/speech-to-text
async function transcribeViaSarvam(audioBuffer) {
  const form = new FormData()
  form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg')
  form.append('model', 'saarika:v2.5')
  form.append('language_code', 'unknown') // auto-detect Hindi/English/Hinglish

  const res = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': SARVAM_API_KEY },
    body: form,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Sarvam API ${res.status}: ${errText.substring(0, 200)}`)
  }
  const data = await res.json()
  return { text: data.transcript || data.text || '', costUsd: 0.004 }  // ~₹0.30/min
}
