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

export async function transcribeAudio(mediaUrl) {
  if (!mediaUrl) return null
  if (!isTranscriptionConfigured()) {
    console.log(`[Transcribe] ${PROVIDER} not configured (missing API key) — skipping`)
    return null
  }

  const startTime = Date.now()
  try {
    // 1. Download the audio bytes from wwbun's storage
    const audioRes = await fetch(mediaUrl)
    if (!audioRes.ok) {
      console.error(`[Transcribe] Audio fetch failed: ${audioRes.status} ${audioRes.statusText}`)
      return null
    }
    const audioBuffer = await audioRes.arrayBuffer()
    const audioBytes = audioBuffer.byteLength
    if (audioBytes < 1000) {
      console.log(`[Transcribe] Audio too small (${audioBytes}B) — skipping`)
      return null
    }

    // 2. Send to configured provider
    let result
    if (PROVIDER === 'groq') result = await transcribeViaGroq(audioBuffer)
    else if (PROVIDER === 'openai') result = await transcribeViaOpenAI(audioBuffer)
    else if (PROVIDER === 'sarvam') result = await transcribeViaSarvam(audioBuffer)
    else {
      console.error(`[Transcribe] Unknown provider: ${PROVIDER}`)
      return null
    }

    if (!result || !result.text || result.text.trim().length < MIN_TRANSCRIPT_LENGTH) {
      console.log(`[Transcribe] Empty/too-short transcript — falling back to media_only`)
      return null
    }

    const durationMs = Date.now() - startTime
    console.log(`[Transcribe] ${PROVIDER} → "${result.text.substring(0, 80)}${result.text.length > 80 ? '…' : ''}" (${durationMs}ms, $${(result.costUsd || 0).toFixed(5)})`)
    return {
      text: result.text.trim(),
      provider: PROVIDER,
      costUsd: result.costUsd || 0,
      durationMs,
    }
  } catch (err) {
    console.error(`[Transcribe] ${PROVIDER} error:`, err.message)
    return null
  }
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
