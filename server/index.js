import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { PrismaClient } from '@prisma/client'
import Anthropic from '@anthropic-ai/sdk'
import { processIncomingMessage, recoverPendingFollowups, DEFAULT_SYSTEM_PROMPT, pendingWelcomeFollowups, pendingDefers, cacheTouch, fallbackState, IG_BUSINESS_ID, IG_VERIFY_TOKEN, notifyOwner, notifySkippedViaWwbun, lastReplySentAt } from './process.js'
import { isStockAvailabilityQuestion, isTransactionalReply, isMediaPlaceholder, isOwnerNumber } from './stock-question.js'
import { syncSavedReplies, syncCatalog, syncStylePairs } from './sync.js'
import { getEmbedding, reEmbedAllDeferItems, reEmbedAllChunks, isVoyageConfigured, storeChunkWithEmbedding } from './embeddings.js'
import { transcribeAudio, transcribeAudioDebug, isTranscriptionConfigured, getTranscriptionProvider, getTranscriptionHealth } from './transcribe.js'
import { runReviewJob, reviewBacklog, pullAndReviewHistory } from './reviewer.js'

const app = new Hono()
const db = new PrismaClient()
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// --- Middleware ---
app.use('*', cors({
  origin: '*',
  credentials: true,
}))

// LOCKDOWN (Ketu-approved 2026-07-06): these endpoints leak buyer phone numbers + full chats and
// were fully public. Now they require EITHER the main shared secret (X-Digital-Ketu-Secret — wwbun
// holds it) OR the low-privilege read token (X-DK-Read-Token = env LOGS_READ_TOKEN — used by the
// local watcher, sweep scripts, and the cloud reviewer; rotate by changing the env var).
// Health + ai-status stay public on purpose (no buyer data; the wwbun banner & monitors need them).
const readGuard = async (c, next) => {
  const settings = await getSettings().catch(() => null)
  const main = settings?.digitalKetuSecret || process.env.DIGITAL_KETU_SECRET
  const read = process.env.LOGS_READ_TOKEN
  const h = c.req.header('X-Digital-Ketu-Secret') || c.req.header('X-DK-Read-Token')
  if ((main && h === main) || (read && h === read)) return next()
  return c.json({ error: 'unauthorized' }, 401)
}
app.use('/api/logs', readGuard)
app.use('/api/learning/manual-pairs', readGuard)
app.use('/api/defer-list', readGuard)
app.use('/api/defer-list/*', readGuard)
app.use('/api/knowledge/chunks', readGuard)
app.use('/api/knowledge/correction/*', readGuard)
app.use('/api/correction', readGuard)
app.use('/api/stock-debug', readGuard)
app.use('/api/defer-stats', readGuard)
app.use('/api/daily-note', readGuard)
app.use('/api/buyer-memory/*', readGuard)

// WRITE LOCKDOWN (Ketu-approved 2026-07-18): mutating admin endpoints were fully public —
// anyone with the URL could PUT /api/settings (flip isActive off, zero the budget, replace the
// system prompt) or fire cost bombs (re-embed, ai-discover, exports). Writes now require EITHER
// the main shared secret OR the admin write token (X-DK-Admin-Token = env ADMIN_WRITE_TOKEN;
// local copy ~/.dk2_admin_token; rotate = change the env var). GET requests pass through
// untouched (public reads unchanged — that exposure is tracked separately). The dashboard
// attaches the header via the fetch shim in dist/index.html (prompts once, localStorage).
// NOT under this guard: /api/incoming, /api/intervention, /api/correction, /api/ask — the
// wwbun s2s paths with their own auth; and DELETE /api/knowledge/correction/:id stays on
// readGuard (the sweep scripts hold only the read token).
const writeGuard = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next()
  const settings = await getSettings().catch(() => null)
  const main = settings?.digitalKetuSecret || process.env.DIGITAL_KETU_SECRET
  const admin = process.env.ADMIN_WRITE_TOKEN
  const h = c.req.header('X-Digital-Ketu-Secret') || c.req.header('X-DK-Admin-Token')
  if ((main && h === main) || (admin && h === admin)) return next()
  return c.json({ error: 'unauthorized (write)' }, 401)
}
for (const p of [
  '/api/settings',
  '/api/admin/*',
  '/api/learning/run', '/api/learning/reset-manual-pairs', '/api/learning/backlog',
  '/api/learning/history-pull', '/api/learning/toggle',
  '/api/embeddings/re-embed',
  '/api/filters', '/api/filters/*',
  '/api/sync/*',
  '/api/premium-export/*',
  '/api/export/*',
  '/api/knowledge/reply-template/*',
  '/api/daily-note',
  '/api/buyer-memory/*',
]) app.use(p, writeGuard)

// --- Health Check ---
// /api/health does a real DB probe so external monitors (UptimeRobot) see RED when Neon is
// down — the missing signal that let both outages run for days. Point UptimeRobot here.
app.get('/api/health', async (c) => {
  try {
    await db.$queryRaw`SELECT 1`
    return c.json({ status: 'ok', service: 'digital-ketu2', db: 'connected' })
  } catch (err) {
    return c.json({ status: 'degraded', service: 'digital-ketu2', db: 'disconnected', error: err.message }, 503)
  }
})
// Liveness only (no DB). Use THIS as Railway's healthcheck path so a brief Neon cold-start
// hiccup can't trigger a restart loop — it only fails if the process itself is hung.
app.get('/api/health/live', (c) => c.json({ status: 'alive', service: 'digital-ketu2' }))

// LIVE STOCK FEED debug view (2026-07-21): the exact 📦 block the model receives on a stock-intent
// message, built from live pc.js + coming-soon sources. Read-token gated. ?raw=1 → structured JSON.
app.get('/api/stock-debug', async (c) => {
  try {
    const { getStockSnapshot, formatStockBlock } = await import('./stock-lookup.js')
    const snap = await getStockSnapshot()
    if (c.req.query('raw')) return c.json(snap)
    return c.text(formatStockBlock(snap) || '(empty snapshot)')
  } catch (err) {
    return c.json({ error: err.message }, 502)
  }
})

// "AAJ KA NOTE" daily-pulse (2026-07-21): one line from Ketu that shapes ALL of today's replies —
// "aaj godam 2 baje band", "Holi hai, parso dispatch". Auto-expires at IST midnight (injection
// checks the IST day, no cron needed). POST {note} sets, DELETE clears, GET shows (read = public
// GET passthrough on writeGuard, same as /api/settings).
app.post('/api/daily-note', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const note = String(body.note || '').trim().slice(0, 300)
  if (!note) return c.json({ error: 'note required' }, 400)
  await db.settings.update({ where: { id: 'default' }, data: { dailyNote: note, dailyNoteSetAt: new Date() } })
  cachedSettings = null; settingsCacheExpiry = 0 // take effect immediately, not up to 60s later
  return c.json({ ok: true, note })
})
app.delete('/api/daily-note', async (c) => {
  await db.settings.update({ where: { id: 'default' }, data: { dailyNote: null, dailyNoteSetAt: null } })
  cachedSettings = null; settingsCacheExpiry = 0
  return c.json({ ok: true })
})
app.get('/api/daily-note', async (c) => {
  const s = await db.settings.findUnique({ where: { id: 'default' }, select: { dailyNote: true, dailyNoteSetAt: true } })
  return c.json(s || {})
})

// BUYER MEMORY admin notes (2026-07-21): durable per-buyer facts ("VIP, Ketu quoted ₹190/pc").
// Language preference is auto-written by the pipeline; this endpoint is for the notes field.
app.post('/api/buyer-memory/:number', async (c) => {
  const number = String(c.req.param('number') || '').replace(/\D/g, '').slice(-10)
  if (number.length !== 10) return c.json({ error: 'need a 10-digit number' }, 400)
  const body = await c.req.json().catch(() => ({}))
  const data = {}
  if ('notes' in body) data.notes = body.notes ? String(body.notes).slice(0, 500) : null
  if ('language' in body) data.language = body.language ? String(body.language).toLowerCase() : null
  if (!Object.keys(data).length) return c.json({ error: 'nothing to set' }, 400)
  const row = await db.buyerMemory.upsert({
    where: { whatsappNumber: number },
    update: data,
    create: { whatsappNumber: number, ...data },
  })
  return c.json(row)
})
app.get('/api/buyer-memory/:number', async (c) => {
  const number = String(c.req.param('number') || '').replace(/\D/g, '').slice(-10)
  const row = await db.buyerMemory.findUnique({ where: { whatsappNumber: number } })
  return c.json(row || {})
})

// DEFER SCOREBOARD (2026-07-21, Ketu-approved): "the human requirement of Ketu will keep decreasing
// until there is a real human requirement." Buckets recent handoffs so progress toward full
// replacement is a NUMBER. ?days=N (default 7).
app.get('/api/defer-stats', async (c) => {
  const days = Math.min(90, Math.max(1, parseInt(c.req.query('days') || '7', 10) || 7))
  const since = new Date(Date.now() - days * 86400000)
  const logs = await db.messageLog.findMany({
    where: { createdAt: { gte: since } },
    select: { status: true, deferReason: true },
  })
  const total = logs.length
  const replied = logs.filter(l => l.status === 'REPLIED').length
  const deferred = logs.filter(l => l.status === 'DEFERRED')
  const buckets = {}
  for (const l of deferred) {
    const key = l.deferReason || 'unspecified'
    buckets[key] = (buckets[key] || 0) + 1
  }
  return c.json({
    days,
    totalMessages: total,
    replied,
    deferred: deferred.length,
    deferRatePct: total ? Math.round((deferred.length / total) * 1000) / 10 : 0,
    buckets: Object.fromEntries(Object.entries(buckets).sort((a, b) => b[1] - a[1])),
  })
})

// AI DOWN-ALERT for the wwbun operator banner: is the reply brain actually answering, or is
// something blocking it (Anthropic usage-limit / overload / rate-limit / DB)? A reply-call
// failure is logged as status:'FAILED' with the raw API error in deferReason (process.js), so we
// read recent logs and surface the EXACT reason. CORS-open + no secret so the wwbun frontend can
// poll it directly; it returns status + error text only (no buyer data). Origin: 2026-06-27 — the
// Anthropic monthly usage limit was hit at 26 Jun 14:23 IST and the clone went dark ~19h unnoticed.
// Cached live probe — one tiny Haiku call to confirm the Anthropic API is actually answering RIGHT
// NOW (it shares the account's usage limit, so it fails the same way when capped, and succeeds the
// moment the limit is raised). Fires ONLY when the status endpoint already suspects down, cached
// 60s — so it costs ~nothing in steady state but lets the banner auto-clear within ~1min of a fix
// even while the operator is replying manually (no organic Opus call needed to confirm recovery).
let aiProbeCache = null // { ts, ok, errMsg }
async function probeAnthropic() {
  if (aiProbeCache && Date.now() - aiProbeCache.ts < 60 * 1000) return aiProbeCache
  let out
  try {
    await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
    out = { ok: true, errMsg: null }
  } catch (e) {
    out = { ok: false, errMsg: e?.message || String(e) }
  }
  out.ts = Date.now()
  aiProbeCache = out
  return out
}
app.get('/api/ai-status', async (c) => {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cache-Control', 'no-store')
  let dbOk = true
  try { await db.$queryRaw`SELECT 1` } catch { dbOk = false }
  try {
    const recent = await db.messageLog.findMany({
      orderBy: { createdAt: 'desc' }, take: 60,
      select: { createdAt: true, status: true, deferReason: true, costUsd: true, aiReply: true },
    })
    const API_ERR = /usage limit|overloaded|rate.?limit|invalid_request|"type"\s*:\s*"error"|^\s*\d{3}\s/i
    const isErr = (r) => r.status === 'FAILED' || API_ERR.test(r.deferReason || '')
    const isPaid = (r) => (Number(r.costUsd) || 0) > 0.0003 && (r.aiReply || '').trim()
    const lastError = recent.find(isErr)
    const lastPaid = recent.find(isPaid)
    const errFresh = lastError && (Date.now() - new Date(lastError.createdAt).getTime() < 2 * 60 * 60 * 1000)
    const errNewest = lastError && (!lastPaid || new Date(lastError.createdAt) > new Date(lastPaid.createdAt))
    const humanize = (dt) => {
      const d = String(dt).toLowerCase()
      if (d.includes('usage limit')) {
        const when = (String(dt).match(/regain access on ([0-9:\sA-Za-z\-]+UTC)/i) || [])[1]
        return `Anthropic API monthly usage limit reached — AI replies are PAUSED${when ? ` (resets ${when.trim()})` : ''}. Raise the limit at console.anthropic.com → Billing → Limits to resume now.`
      }
      if (d.includes('overloaded')) return 'Anthropic API temporarily overloaded — replies delayed, auto-retrying.'
      if (d.includes('rate') || /^\s*429/.test(String(dt))) return 'Anthropic rate limit hit — replies throttled, auto-retrying.'
      return `AI reply error: ${String(dt).slice(0, 180)}`
    }
    let down = false, reason = null, detail = null, since = null, probed = false
    if (!dbOk) {
      down = true; reason = 'Database disconnected — the clone cannot read or reply.'; detail = 'db_disconnected'
    } else if (errFresh && errNewest) {
      // Suspected down from the logs — but the operator may be replying manually (no fresh Opus
      // call to confirm recovery). PROBE the API live so the banner reflects the TRUE current state
      // and clears within ~1min of a limit-raise / outage ending.
      probed = true
      const probe = await probeAnthropic()
      if (!probe.ok) {
        down = true
        detail = probe.errMsg || lastError.deferReason || lastError.status
        since = lastError.createdAt
        reason = humanize(detail)
      }
      // probe.ok === true → API answering again → leave down=false (recovered)
    }
    // FALLBACK-ACTIVE: if the OpenAI backup answered a buyer in the last 10 min, Claude/Anthropic is
    // effectively down but the shop is still replying (on gpt-4o-mini). The reply-call failures are
    // logged as REPLIED (fallback), so the FAILED-based down-detector above stays quiet — surface the
    // true state here so the banner shows "on backup" instead of falsely reading all-clear.
    const onFallback = fallbackState.at > 0 && (Date.now() - fallbackState.at < 10 * 60 * 1000)
    if (onFallback && !down) {
      reason = `Claude (Anthropic) is down — running on the OpenAI backup brain (${fallbackState.model || 'gpt-4o-mini'}). Buyers ARE getting replies; top up Anthropic credits to restore full quality.`
      detail = 'openai_fallback_active'
    }
    return c.json({ ok: !down, down, onFallback, brain: onFallback ? (fallbackState.model || 'openai-fallback') : 'claude', reason, detail, since, probed, lastPaidReplyAt: lastPaid?.createdAt || null, cost: { avgInr: costAlarm.avgInr, ceiling: costAlarm.ceiling, over: costAlarm.over, replies: costAlarm.replies }, checkedAt: new Date().toISOString() })
  } catch (e) {
    return c.json({ ok: false, down: true, reason: `Status check failed: ${e.message}`, detail: 'status_error' })
  }
})

// Which database is production actually connected to? (Settles the Neon-vs-Railway-PG
// question without dashboard access.) Secret-gated; reports host/db/version only — the
// connection string's credentials never leave the server.
app.get('/api/admin/db-info', async (c) => {
  const settings = await getSettings()
  const SECRET = settings.digitalKetuSecret || process.env.DIGITAL_KETU_SECRET
  if (!SECRET || c.req.header('X-Digital-Ketu-Secret') !== SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  try {
    const u = new URL(process.env.DATABASE_URL || 'postgres://unset')
    const ver = await db.$queryRaw`SELECT version() AS v`
    const vec = await db.$queryRaw`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'`
    const chunks = await db.knowledgeChunk.count()
    const withEmbedding = await db.$queryRaw`SELECT count(*)::int AS n FROM "KnowledgeChunk" WHERE embedding IS NOT NULL`
    return c.json({
      host: u.hostname,
      port: u.port || '5432',
      database: u.pathname.replace('/', ''),
      serverVersion: ver?.[0]?.v || null,
      pgvector: (vec?.[0]?.n || 0) > 0,
      knowledgeChunks: chunks,
      chunksWithEmbedding: withEmbedding?.[0]?.n || 0,
    })
  } catch (e) {
    return c.json({ error: e.message }, 500)
  }
})

// Voice-transcription health for the wwbun dashboard badge (green = working, red = broken).
app.get('/api/transcription-health', (c) => c.json(getTranscriptionHealth()))

// TEMPORARY diagnostic: why are buyer voice notes failing transcription? Token-guarded.
// Pass ?id=<wwbunMessageId>&token=... — runs the same download+transcribe chain the
// pipeline uses and reports each step's status + the provider's error body.
app.get('/api/debug/transcribe-test', async (c) => {
  if (c.req.query('token') !== 'dk2diag-9f3a2c7e') return c.json({ error: 'unauthorized' }, 401)
  const out = { configured: isTranscriptionConfigured(), provider: getTranscriptionProvider() }
  const settings = await getSettings()
  const WWBUN_API_URL = settings.wwbunApiUrl || process.env.WWBUN_API_URL
  const SECRET = settings.digitalKetuSecret || process.env.DIGITAL_KETU_SECRET
  const hdr = SECRET ? { 'X-Digital-Ketu-Secret': SECRET } : {}
  out.wwbunConfigured = !!WWBUN_API_URL
  try {
    // Mode 1: raw URL — test Sarvam directly on any audio URL (isolates provider vs URL).
    if (c.req.query('url')) {
      Object.assign(out, await transcribeAudioDebug(c.req.query('url')))
      return c.json(out)
    }
    // Mode 2: findAudio — locate the latest INBOUND buyer voice note in wwbun and run the
    // full real chain (search -> download-media -> Sarvam). This is the genuine failing case.
    let id = c.req.query('id')
    let mediaKind = 'audio'
    // Mode 2b: findImage — locate the latest INBOUND image (optionally from a given number) and
    // return its media URL so it can be fetched + viewed. Generalizes the media-retrieval capability.
    if (!id && (c.req.query('findImage') || c.req.query('findAudio'))) {
      mediaKind = c.req.query('findImage') ? 'image' : 'audio'
      const marker = mediaKind === 'image' ? '[Image]' : '[Audio]'
      const num = (c.req.query('number') || '').replace(/\D/g, '')
      const sr = await fetch(`${WWBUN_API_URL}/api/messages/search?q=${encodeURIComponent(marker)}`, { headers: hdr })
      out.searchStatus = sr.status
      const msgs = await sr.json().catch(() => [])
      const list = Array.isArray(msgs) ? msgs : []
      let inbound = list.filter(m => m.status === 'DELIVERED' && new RegExp(mediaKind, 'i').test(m.messageType || ''))
      if (num) inbound = inbound.filter(m => (m.contactNumber || '').replace(/\D/g, '').endsWith(num.slice(-10)))
      out.inboundFound = inbound.length
      if (!inbound.length) { out.error = `no inbound ${mediaKind} found via search`; return c.json(out) }
      id = inbound[0].id
      out.testedCreatedAt = inbound[0].createdAt
    }
    if (!id) { out.error = 'pass ?id=, ?findAudio=1, ?findImage=1[&number=], or ?url='; return c.json(out) }
    out.testedMessageId = id
    const dl = await fetch(`${WWBUN_API_URL}/api/messages/${id}/download-media`, { headers: hdr })
    out.downloadStatus = dl.status
    const dlData = await dl.json().catch(() => ({}))
    out.mediaUrl = dlData.mediaUrl || null
    if (dlData.error) out.downloadError = dlData.error
    if (dlData.messageType) out.wwbunMessageType = dlData.messageType
    if (dlData.contentPreview) out.wwbunContentPreview = dlData.contentPreview
    // Only transcribe audio; for images just return the URL to fetch + view.
    if (dlData.mediaUrl && mediaKind === 'audio') Object.assign(out, await transcribeAudioDebug(dlData.mediaUrl))
  } catch (err) {
    out.error = err.message
  }
  return c.json(out)
})

// --- Settings ---
// 60-second TTL cache. Cost increments elsewhere use Prisma's atomic
// { increment: ... } operator, so stale reads can't corrupt totals.
let cachedSettings = null
let settingsCacheExpiry = 0
const SETTINGS_CACHE_TTL_MS = 60 * 1000

async function getSettings() {
  const tsNow = Date.now()
  if (cachedSettings && tsNow < settingsCacheExpiry) {
    return cachedSettings
  }
  let settings = await db.settings.findUnique({ where: { id: 'default' } })
  if (!settings) {
    settings = await db.settings.create({ data: { id: 'default' } })
  }
  // Reset daily spend counters if it's a new day (covers both main AI and learning)
  // Learning reset used to live inside the scheduled reviewer, but that scheduler was
  // disabled — without this, learningDailySpentUsd freezes at its last value forever.
  const now = new Date()
  const updates = {}
  if (now.toDateString() !== new Date(settings.dailySpentResetAt).toDateString()) {
    updates.dailySpentUsd = 0
    updates.dailySpentResetAt = now
  }
  const learningResetAt = settings.learningSpentResetAt ? new Date(settings.learningSpentResetAt) : new Date(0)
  if (now.toDateString() !== learningResetAt.toDateString()) {
    updates.learningDailySpentUsd = 0
    updates.learningSpentResetAt = now
  }
  if (Object.keys(updates).length > 0) {
    settings = await db.settings.update({ where: { id: 'default' }, data: updates })
  }
  cachedSettings = settings
  settingsCacheExpiry = tsNow + SETTINGS_CACHE_TTL_MS
  return settings
}

app.get('/api/settings', async (c) => {
  const settings = await getSettings()
  return c.json(settings)
})

app.put('/api/settings', async (c) => {
  const body = await c.req.json()
  const settings = await db.settings.update({
    where: { id: 'default' },
    data: body,
  })
  // Invalidate cache so the new value takes effect immediately, not up to 60s later
  cachedSettings = null
  settingsCacheExpiry = 0
  return c.json(settings)
})

// ===========================================
// CORE: Incoming message from wwbun
// ===========================================
// wwbun forwards incoming WhatsApp messages here

// Buffer for message merging (same sender within 3 sec = one thought)
const messageBuffer = new Map() // whatsappNumber -> { messages: [], timer: null }

// Shared enqueue used by BOTH /api/incoming (WhatsApp via wwbun) and /ig/webhook (Instagram,
// senderKey 'ig:<IGSID>'). Extracted verbatim from the /api/incoming handler — same followup/defer
// pausing, same merge buffer, same settle timer, same processIncomingMessage handoff.
async function enqueueIncoming(senderKey, message) {
  // Cancel pending welcome followup if buyer sends another message
  if (pendingWelcomeFollowups.has(senderKey)) {
    clearTimeout(pendingWelcomeFollowups.get(senderKey).timer)
    pendingWelcomeFollowups.delete(senderKey)
    console.log(`[Welcome] ${senderKey} — cancelled pending followup (new message received)`)
  }

  // Pause pending defer timer — new message arrived, let it process first
  // The defer will be restarted/batched/cancelled by processIncomingMessage
  if (pendingDefers.has(senderKey)) {
    const pending = pendingDefers.get(senderKey)
    clearTimeout(pending.timer)
    pending.timer = null
    console.log(`[DeferBatch] ${senderKey} — paused defer timer (new message received)`)
  }

  // Add to merge buffer
  const bufferKey = senderKey
  if (!messageBuffer.has(bufferKey)) {
    messageBuffer.set(bufferKey, { messages: [], timer: null })
  }
  const buffer = messageBuffer.get(bufferKey)
  buffer.messages.push({
    messageText: message.messageText || '',
    messageId: message.messageId,
    messageType: message.messageType || 'text',
    hasMedia: message.hasMedia || false,
    timestamp: message.timestamp || new Date().toISOString(),
    senderName: message.senderName,
    quotedText: message.quotedText || null,
    mediaUrl: message.mediaUrl || null,
    wwbunMessageId: message.wwbunMessageId || null,
  })

  // Clear existing timer and set new one (merge window)
  if (buffer.timer) clearTimeout(buffer.timer)

  const settings = await getSettings()
  // (A) In Full AI mode, wait longer so a buyer firing several messages in a row gets ONE
  // consolidated reply — like a human reading the whole thing — instead of a reply per message.
  // Each new message resets this timer, so it only fires once the buyer pauses. Partial mode
  // keeps its fast window unchanged.
  const FULL_AI_SETTLE_MS = 15000
  const windowMs = settings.isActive ? FULL_AI_SETTLE_MS : settings.mergeWindowMs
  buffer.timer = setTimeout(async () => {
    const merged = messageBuffer.get(bufferKey)
    messageBuffer.delete(bufferKey)
    if (!merged || merged.messages.length === 0) return

    const startedAt = Date.now()
    try {
      await processIncomingMessage({
        whatsappNumber: senderKey,
        messages: merged.messages,
        db,
        anthropic,
        settings,
      })
    } catch (err) {
      console.error(`[Process Error] ${senderKey}:`, err.message)
    }
    // Clear wwbun's "Digital Ketu is preparing a reply" badge only when this turn concluded WITHOUT
    // any reply on the way — a genuine skip (cooldown, off-hours, filtered) or an error. Exclude:
    //  - a reply just SENT this turn (lastReplySentAt ≥ startedAt) — send-ai-reply already cleared it;
    //    firing again would be a wasted POST that can race-clear a NEW message's fresh badge.
    //  - a DEFERRED reply (pendingDefers) — clears when its timer resolves.
    //  - a scheduled welcome nudge (pendingWelcomeFollowups) — clears when the nudge is sent.
    // Fire-and-forget; the 2-min client self-heal is the backstop.
    const repliedThisTurn = (lastReplySentAt.get(senderKey) || 0) >= startedAt
    if (!repliedThisTurn && !pendingDefers.has(senderKey) && !pendingWelcomeFollowups.has(senderKey)) {
      notifySkippedViaWwbun(senderKey)
    }
  }, windowMs)

  return buffer.messages.length
}

app.post('/api/incoming', async (c) => {
  const body = await c.req.json()
  const {
    whatsappNumber,
    messageText,
    messageId,
    messageType,  // text, image, audio, video, document, etc.
    hasMedia,
    timestamp,
    senderName,
    quotedText,   // text of the message buyer is replying to (if any)
    mediaUrl,     // URL of downloaded media (image/doc) from wwbun storage
    wwbunMessageId, // wwbun DB message ID (for on-demand media download)
  } = body

  if (!whatsappNumber || !messageId) {
    return c.json({ error: 'Missing whatsappNumber or messageId' }, 400)
  }

  // Duplicate protection: check if we already processed this messageId
  const existing = await db.messageLog.findFirst({
    where: { messageIds: { has: messageId } }
  })
  if (existing) {
    return c.json({ status: 'duplicate', message: 'Already processed' })
  }

  const bufferSize = await enqueueIncoming(whatsappNumber, {
    messageText, messageId, messageType, hasMedia, timestamp, senderName, quotedText, mediaUrl, wwbunMessageId,
  })

  return c.json({ status: 'buffered', bufferSize })
})

// ===========================================
// Instagram DM webhook (Meta Graph API)
// ===========================================
// IG conversations ride the SAME buffer + pipeline as WhatsApp, keyed 'ig:<IGSID>' — the
// prefix guards every IG-specific branch downstream (cost gate, Graph API send, persona).

// Meta verification handshake — must return the raw challenge as text/plain, NOT JSON.
app.get('/ig/webhook', (c) => {
  if (
    c.req.query('hub.mode') === 'subscribe' &&
    IG_VERIFY_TOKEN &&
    c.req.query('hub.verify_token') === IG_VERIFY_TOKEN
  ) {
    return c.text(c.req.query('hub.challenge') || '')
  }
  return c.text('forbidden', 403)
})

// In-memory recent-mid dedupe: Meta retries can land inside the merge window BEFORE any
// MessageLog row exists, so the DB `has` check alone can't catch them.
const recentIgMids = new Set()
const RECENT_IG_MIDS_MAX = 500

app.post('/ig/webhook', async (c) => {
  try {
    const body = await c.req.json().catch(() => null)
    // Tolerate 'page' too (events can route via the linked Facebook Page)
    if (body && (body.object === 'instagram' || body.object === 'page')) {
      for (const entry of body.entry || []) {
        for (const ev of entry.messaging || []) {
          try {
            const msg = ev.message
            if (!msg) continue                 // read/delivery/reaction/postback events — ignore
            if (msg.is_echo) continue          // our own outbound echoed back — replying would loop forever
            const senderId = ev.sender?.id
            if (!senderId) continue
            if (IG_BUSINESS_ID && String(senderId) === String(IG_BUSINESS_ID)) continue // self-sent

            const text = (msg.text || '').trim()
            const attachments = msg.attachments || []
            if (!text && attachments.length === 0) continue

            const mid = msg.mid
            if (!mid) continue
            // Dedupe (Meta retries non-200s): fast in-memory set + the MessageLog `has` check
            if (recentIgMids.has(mid)) continue
            const existing = await db.messageLog.findFirst({
              where: { messageIds: { has: mid } },
              select: { id: true },
            })
            if (existing) continue
            recentIgMids.add(mid)
            if (recentIgMids.size > RECENT_IG_MIDS_MAX) {
              recentIgMids.delete(recentIgMids.values().next().value)
            }

            // Attachments without text → '[media]' marker so the IG cost gate can zero-cost
            // skip it. Story replies are tagged so the gate can zero-tier them even with text.
            const isStoryReply = !!(msg.reply_to && msg.reply_to.story)
            const messageText = text || '[media]'
            const messageType = isStoryReply ? 'ig_story_reply' : 'text'

            console.log(`[IG] DM from ${senderId}: "${messageText.slice(0, 60)}"`)
            await enqueueIncoming(`ig:${senderId}`, {
              messageText,
              messageId: mid,
              messageType,
              timestamp: ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString(),
            })
          } catch (err) {
            console.error('[IG] event error (continuing):', err.message)
          }
        }
      }
    }
  } catch (err) {
    console.error('[IG] webhook error:', err.message)
  }
  // ALWAYS ack 200 fast — Meta retries non-200s and eventually disables the subscription
  return c.json({ status: 'ok' })
})

// ===========================================
// Owner Command Channel — POST /api/ask
// ===========================================
// ISOLATED from the customer auto-reply pipeline (/api/incoming). wwbun calls this ONLY for
// messages from the owner's OWN number, so he can WhatsApp his company number and get a Claude
// answer back. Reuses the existing `anthropic` client + voice transcription. Reads/writes NO
// customer conversation, learning, or message-log state — so it cannot affect auto-replies.
app.post('/api/ask', async (c) => {
  try {
    const settings = await getSettings()
    const SECRET = settings.digitalKetuSecret || process.env.DIGITAL_KETU_SECRET
    if (SECRET && c.req.header('X-Digital-Ketu-Secret') !== SECRET) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const body = await c.req.json()
    let { text, mediaUrl, messageType } = body

    // Voice note → text, reusing the SAME transcription the customer pipeline uses. For audio we
    // always transcribe (wwbun sends "[Audio]" as a placeholder, so ignore the provided text).
    if (mediaUrl && (messageType === 'audio' || messageType === 'AUDIO')) {
      try {
        const result = await transcribeAudio(mediaUrl)
        if (result && result.text) text = result.text
      } catch (e) {
        console.warn('[Ask] transcription failed:', e.message)
      }
    }

    if (!text || !text.trim()) {
      return c.json({ answer: "I couldn't read that — please send text or a clearer voice note." })
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: "You are the elite senior operator for the owner of Own Knitted Blank Wears (a wholesale t-shirt business) and his software projects. He messages you from his OWN WhatsApp to give you instructions and get your judgment — this is NOT a customer. Behave like a sharp, decisive expert he relies on, not a deferential assistant: take his instruction, give a direct answer or a strong, clear recommendation he can act on immediately. No hedging, no flattery, no sales tone, do not ask permission for obvious next steps. Reply in his language (Hindi / English / Hinglish), concise and WhatsApp-friendly. If something needs an action you cannot perform from this chat (run/deploy code, place an order), state plainly what's needed and the exact next step.",
      messages: [{ role: 'user', content: text }],
    })
    const answer = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      || "Sorry, I couldn't come up with an answer."
    return c.json({ answer })
  } catch (error) {
    console.error('[Ask] error:', error.message)
    return c.json({ answer: 'Sorry, something went wrong handling that. Please try again.' })
  }
})

// ===========================================
// Manual Intervention Detection
// ===========================================
// wwbun calls this when Om sends a manual message in a conversation

app.post('/api/intervention', async (c) => {
  const body = await c.req.json()
  const { whatsappNumber, messageType, buyerMessage, aiReply, aiRepliedAt } = body
  let { ketuReply } = body
  const ketuMediaUrl = body.mediaUrl || body.ketuMediaUrl || null
  if (!whatsappNumber) return c.json({ error: 'Missing whatsappNumber' }, 400)

  // 1. Set cooldown FIRST and respond — this is the only time-critical part (the AI loop
  // re-checks it from DB before sending). wwbun awaits this endpoint on every manual send,
  // so transcription/embedding/learning below must never block the operator's send.
  const settings = await getSettings()
  const cooldownUntil = new Date(Date.now() + settings.cooldownMinutes * 60 * 1000)

  const interventionConvo = await db.buyerConversation.upsert({
    where: { whatsappNumber },
    update: { cooldownUntil, lastMessageAt: new Date() },
    create: { whatsappNumber, cooldownUntil, lastMessageAt: new Date() },
  })

  console.log(`[Cooldown] ${whatsappNumber} — paused until ${cooldownUntil.toISOString()}`)

  // Owner's own number = the /api/ask owner channel, not a buyer. Never feed-log or learn from it.
  if (isOwnerNumber(whatsappNumber)) {
    return c.json({ status: 'cooldown_set', cooldownUntil, learned: 'skipped_owner_number' })
  }

  // Everything below (transcription, feed log, self-learning) runs after the response.
  ;(async () => {

  // --- AUDIO TRANSCRIPTION (Path B: Om's voice reply → learning) ---
  // If the reply was audio and wwbun sent us the mediaUrl, transcribe to text so the pair
  // becomes reusable learning signal instead of being silently dropped as non-text.
  if ((messageType === 'AUDIO' || messageType === 'audio') && ketuMediaUrl && isTranscriptionConfigured()) {
    const result = await transcribeAudio(ketuMediaUrl)
    if (result && result.text) {
      console.log(`[Transcribe] ${whatsappNumber} — Om's voice reply → text: "${result.text.substring(0, 60)}…" (${getTranscriptionProvider()})`)
      ketuReply = result.text
    } else {
      console.log(`[Transcribe] ${whatsappNumber} — Om's voice reply transcription failed, will skip learning (cooldown only)`)
    }
  }

  // Skip learning for non-text replies (audio, video, image, etc.) — only set cooldown.
  // If audio was transcribed above, we treat it as text from here on.
  const effectiveType = (ketuReply && !messageType) ? 'TEXT'
    : ((messageType === 'AUDIO' || messageType === 'audio') && ketuReply ? 'TEXT' : messageType)
  const isTextReply = !effectiveType || effectiveType === 'TEXT'

  // Quality filter: capture short-buyer-question + meaningful-Om-reply pairs like
  // "rate?" → "Catalog mein hai sir, 205 per pc". Previously both sides needed 4+ words
  // which dropped ~180 useful pairs/day. Now buyer ≥2 words, Om ≥3 words.
  const wordCount = (s) => (s || '').split(/\s+/).filter(w => w.length > 0).length
  const isQualityPair = isTextReply && wordCount(buyerMessage) >= 2 && wordCount(ketuReply) >= 3

  // Real-time feed of Om's manual replies for monitoring. manualReplyPair only stores AI-OFF
  // pairs and interventions go to corrections, so manual replies were invisible to the watch loop.
  // Log every manual reply (status SKIPPED + deferReason 'manual_reply', cost 0) so /api/logs is a
  // single live feed of both AI replies and Om's manual replies. Does not affect learning.
  if (ketuReply && ketuReply.trim()) {
    try {
      await db.messageLog.create({
        data: {
          conversationId: interventionConvo.id,
          buyerMessage: buyerMessage || '',
          messageIds: [],
          status: 'SKIPPED',
          deferReason: 'manual_reply',
          aiReply: ketuReply,
          processingMs: 0,
        },
      })
    } catch (e) { console.error('[Intervention] manual-reply log failed:', e.message) }
  }

  // 2. SELF-LEARNING: If AI was ON and replied recently (within 10 min), this is an intervention
  //    AI got it wrong → auto-add correction to DeferToKetu
  const isIntervention = aiReply && aiRepliedAt &&
    (Date.now() - new Date(aiRepliedAt).getTime()) < 10 * 60 * 1000

  let learned = null

  if (isQualityPair && isIntervention && buyerMessage && ketuReply && (isStockAvailabilityQuestion(buyerMessage) || isTransactionalReply(ketuReply) || isMediaPlaceholder(buyerMessage))) {
    // Point-in-time / transactional replies — stock-availability answers OR dispatch/tracking
    // notifications (Porter links, referral codes) — must never become a permanent correction.
    learned = 'intervention_skipped_point_in_time'
    console.log(`[AutoLearn] Intervention SKIPPED — point-in-time/transactional, not learnable: "${buyerMessage.substring(0, 50)}..."`)
  } else if (isQualityPair && isIntervention && buyerMessage && ketuReply) {
    try {
      const embedding = await getEmbedding(anthropic, buyerMessage)
      const deferId = crypto.randomUUID()
      await db.$executeRaw`
        INSERT INTO "DeferToKetu" (id, "buyerQuestion", "aiWrongReply", "correctReply", embedding, "triggerCount", "createdAt", "updatedAt")
        VALUES (${deferId}, ${buyerMessage}, ${aiReply}, ${ketuReply}, ${embedding}::vector, 0, NOW(), NOW())
      `
      // Also add to KnowledgeChunk as CORRECTION source (4th vector search source)
      const content = `Buyer: ${buyerMessage}\nCorrect reply: ${ketuReply}`
      const chunkId = crypto.randomUUID()
      await db.$executeRaw`
        INSERT INTO "KnowledgeChunk" (id, source, "sourceId", title, content, embedding, metadata, "createdAt", "updatedAt")
        VALUES (${chunkId}, 'CORRECTION', ${deferId}, ${buyerMessage.substring(0, 80)}, ${content}, ${embedding}::vector, ${JSON.stringify({ aiWrongReply: aiReply || '', correctReply: ketuReply })}::jsonb, NOW(), NOW())
      `
      learned = 'intervention_correction'
      console.log(`[AutoLearn] Intervention — added correction to knowledge base: "${buyerMessage.substring(0, 50)}..."`)
    } catch (err) {
      console.error('[AutoLearn] Failed to add intervention correction:', err.message)
    }
  }

  // 3. SELF-LEARNING: If AI was OFF (no recent AI reply), store pair for batch review
  if (isQualityPair && !isIntervention && buyerMessage && ketuReply) {
    try {
      await db.manualReplyPair.create({
        data: { whatsappNumber, buyerMessage, ketuReply },
      })
      learned = 'manual_pair_stored'
      console.log(`[AutoLearn] Manual pair stored: "${buyerMessage.substring(0, 50)}..."`)
    } catch (err) {
      console.error('[AutoLearn] Failed to store manual pair:', err.message)
    }
  }

  if (learned) console.log(`[Intervention] ${whatsappNumber} — background learning done: ${learned}`)

  })().catch(err => console.error('[Intervention] background learning error:', err.message))

  return c.json({ status: 'cooldown_set', cooldownUntil, learned: 'deferred' })
})

// ===========================================
// Edit Button Callback (Defer to Ketu)
// ===========================================
// wwbun calls this when Om edits an AI reply via the Edit button

app.post('/api/correction', async (c) => {
  const { buyerQuestion, aiWrongReply, correctReply } = await c.req.json()
  if (!buyerQuestion || !correctReply) {
    return c.json({ error: 'Missing buyerQuestion or correctReply' }, 400)
  }

  // Point-in-time / transactional answers (stock/availability, or dispatch-tracking/referral
  // messages) must not be captured — they go stale or leak a one-order link. Skip them.
  if (isStockAvailabilityQuestion(buyerQuestion) || isTransactionalReply(correctReply) || isMediaPlaceholder(buyerQuestion)) {
    console.log(`[Correction] SKIPPED — point-in-time/transactional, not saved: "${buyerQuestion.substring(0, 50)}..."`)
    return c.json({ status: 'skipped_point_in_time', reason: 'Stock/availability and dispatch/tracking replies are not saved as corrections (they go stale / leak a one-order link).' })
  }

  // Generate embedding for the buyer question
  const embedding = await getEmbedding(anthropic, buyerQuestion)

  // Store in DeferToKetu table (for dashboard display)
  const deferId = crypto.randomUUID()
  await db.$executeRaw`
    INSERT INTO "DeferToKetu" (id, "buyerQuestion", "aiWrongReply", "correctReply", embedding, "triggerCount", "createdAt", "updatedAt")
    VALUES (${deferId}, ${buyerQuestion}, ${aiWrongReply || ''}, ${correctReply}, ${embedding}::vector, 0, NOW(), NOW())
  `

  // Also add to KnowledgeChunk as CORRECTION source (4th vector search source)
  const content = `Buyer: ${buyerQuestion}\nCorrect reply: ${correctReply}`
  const chunkId = crypto.randomUUID()
  await db.$executeRaw`
    INSERT INTO "KnowledgeChunk" (id, source, "sourceId", title, content, embedding, metadata, "createdAt", "updatedAt")
    VALUES (${chunkId}, 'CORRECTION', ${deferId}, ${buyerQuestion.substring(0, 80)}, ${content}, ${embedding}::vector, ${JSON.stringify({ aiWrongReply: aiWrongReply || '', correctReply })}::jsonb, NOW(), NOW())
  `

  console.log(`[Correction] Added to knowledge base: "${buyerQuestion.substring(0, 50)}..."`)
  return c.json({ status: 'saved' })
})

// One-time (idempotent) backfill — copy reviewer-generated corrections from DeferToKetu
// into KnowledgeChunk(CORRECTION), the table the live AI actually reads. The reviewer used
// to write ONLY to DeferToKetu, so months of learned corrections were invisible to the clone.
// Excludes context-dependent (empty) replies and rows already present (dedupe by sourceId).
// Safe to run multiple times. Requires ?confirm=yes.
app.post('/api/admin/backfill-corrections', async (c) => {
  if (c.req.query('confirm') !== 'yes') {
    return c.json({ error: 'Add ?confirm=yes to run. Copies reusable DeferToKetu corrections into KnowledgeChunk(CORRECTION).' }, 400)
  }
  try {
    const before = await db.knowledgeChunk.count({ where: { source: 'CORRECTION' } })
    const inserted = await db.$executeRaw`
      INSERT INTO "KnowledgeChunk" (id, source, "sourceId", title, content, embedding, metadata, "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, 'CORRECTION', d.id, LEFT(d."buyerQuestion", 80),
             'Buyer: ' || d."buyerQuestion" || E'\nCorrect reply: ' || d."correctReply",
             d.embedding,
             jsonb_build_object('aiWrongReply', d."aiWrongReply", 'correctReply', d."correctReply", 'backfilled', true),
             NOW(), NOW()
      FROM "DeferToKetu" d
      WHERE d."correctReply" IS NOT NULL AND d."correctReply" <> ''
        AND d.embedding IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "KnowledgeChunk" k WHERE k.source = 'CORRECTION' AND k."sourceId" = d.id
        )
    `
    const after = await db.knowledgeChunk.count({ where: { source: 'CORRECTION' } })
    console.log(`[Backfill] CORRECTION chunks: ${before} → ${after} (+${Number(inserted)})`)
    return c.json({ status: 'done', correctionsBefore: before, correctionsAfter: after, inserted: Number(inserted) })
  } catch (err) {
    console.error('[Backfill] Error:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

// ===========================================
// Self-Learning APIs
// ===========================================

// Manually trigger a review job
app.post('/api/learning/run', async (c) => {
  const settings = await getSettings()
  if (!settings.learningEnabled) {
    return c.json({ error: 'Learning is disabled. Enable it from Settings.' }, 400)
  }
  try {
    const result = await runReviewJob(db)
    // Track learning cost
    await db.settings.update({
      where: { id: 'default' },
      data: {
        lastReviewAt: new Date(),
        learningDailySpentUsd: { increment: result.totalCostUsd },
      },
    })
    return c.json(result)
  } catch (err) {
    console.error('[Learning] Manual run failed:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

// Reset manual pairs that were reviewed by wrong model (skipped/haiku) so they can be re-reviewed
app.post('/api/learning/reset-manual-pairs', async (c) => {
  const result = await db.manualReplyPair.updateMany({
    where: { reviewedAt: { not: null } },
    data: { reviewedAt: null, reviewResult: null, reviewNote: null, category: null },
  })
  return c.json({ reset: result.count, message: `Reset ${result.count} manual pairs for re-review` })
})

// One-time backlog review — review ALL past AI replies
let backlogRunning = false
let backlogProgress = null

app.post('/api/learning/backlog', async (c) => {
  if (backlogRunning) {
    return c.json({ error: 'Backlog review already running', progress: backlogProgress }, 409)
  }

  backlogRunning = true
  backlogProgress = { status: 'running', batchNumber: 0, totalReviewed: 0, totalCorrections: 0, totalCostUsd: 0 }

  // Run in background (don't block the request)
  reviewBacklog(db, (progress) => {
    backlogProgress = { status: 'running', ...progress }
  }).then(result => {
    backlogProgress = { status: 'complete', ...result }
    backlogRunning = false
    // Update learning cost
    db.settings.update({
      where: { id: 'default' },
      data: { learningDailySpentUsd: { increment: result.totalCostUsd } },
    }).catch(() => {})
    console.log(`[Backlog] Done: ${result.totalReviewed} reviewed, ${result.totalCorrections} corrections, $${result.totalCostUsd.toFixed(4)}`)
  }).catch(err => {
    backlogProgress = { status: 'failed', error: err.message }
    backlogRunning = false
    console.error('[Backlog] Failed:', err.message)
  })

  return c.json({ status: 'started', message: 'Backlog review started. Check /api/learning/backlog/progress for updates.' })
})

app.get('/api/learning/backlog/progress', async (c) => {
  if (!backlogProgress) return c.json({ status: 'not_started' })
  return c.json(backlogProgress)
})

// One-time history pull — fetch pairs from wwbun + review with Opus 4.6
// Default: 1000 pairs. Send { limit: 20 } for a quick test run.
let historyPullRunning = false
let historyPullProgress = null

app.post('/api/learning/history-pull', async (c) => {
  if (historyPullRunning) {
    return c.json({ error: 'History pull already running', progress: historyPullProgress }, 409)
  }

  const body = await c.req.json().catch(() => ({}))
  const limit = Math.min(Math.max(parseInt(body.limit) || 1000, 1), 2000) // 1-2000, default 1000

  historyPullRunning = true
  historyPullProgress = { status: 'running', phase: 'fetching', fetched: 0, stored: 0, reviewed: 0, corrections: 0, costUsd: 0 }

  // Run in background
  pullAndReviewHistory(db, (progress) => {
    historyPullProgress = { status: 'running', ...progress }
  }, { limit }).then(result => {
    historyPullProgress = { status: 'complete', ...result }
    historyPullRunning = false
    // Update learning cost
    db.settings.update({
      where: { id: 'default' },
      data: { learningDailySpentUsd: { increment: result.costUsd } },
    }).catch(() => {})
    console.log(`[HistoryPull] Done: ${result.fetched} fetched, ${result.stored} stored, ${result.reviewed} reviewed, ${result.corrections} corrections`)
  }).catch(err => {
    historyPullProgress = { status: 'failed', error: err.message }
    historyPullRunning = false
    console.error('[HistoryPull] Failed:', err.message)
  })

  return c.json({ status: 'started', message: 'History pull started. Check /api/learning/history-pull/progress for updates.' })
})

app.get('/api/learning/history-pull/progress', async (c) => {
  if (!historyPullProgress) return c.json({ status: 'not_started' })
  return c.json(historyPullProgress)
})

// Category breakdown for dashboard
app.get('/api/learning/categories', async (c) => {
  const categories = await db.manualReplyPair.groupBy({
    by: ['category'],
    where: { category: { not: null } },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  })

  const failsByCategory = await db.manualReplyPair.groupBy({
    by: ['category'],
    where: { category: { not: null }, reviewResult: 'correction_added' },
    _count: { id: true },
  })

  const failMap = {}
  for (const f of failsByCategory) {
    if (f.category) failMap[f.category] = f._count.id
  }

  return c.json(categories.map(c => ({
    category: c.category,
    total: c._count.id,
    aiWouldFail: failMap[c.category] || 0,
    failRate: c._count.id > 0 ? Math.round(((failMap[c.category] || 0) / c._count.id) * 100) : 0,
  })))
})

// Learning stats for dashboard
app.get('/api/learning/stats', async (c) => {
  const settings = await getSettings()

  const [
    totalCorrections,
    interventionCorrections,
    reviewerCorrections,
    manualPairCorrections,
    pendingManualPairs,
    totalAiReviewed,
    totalManualReviewed,
    avgRating,
    todayCorrections,
    recentLearnings,
    recentPremiumPairs,
  ] = await Promise.all([
    db.deferToKetu.count(),
    db.deferToKetu.count({ where: { aiWrongReply: { not: '[AI would not know]' } } }),
    db.messageLog.count({ where: { reviewedAt: { not: null }, reviewRating: { lte: 2 } } }),
    db.deferToKetu.count({ where: { aiWrongReply: '[AI would not know]' } }),
    db.manualReplyPair.count({ where: { reviewedAt: null } }),
    db.messageLog.count({ where: { reviewedAt: { not: null } } }),
    db.manualReplyPair.count({ where: { reviewedAt: { not: null } } }),
    db.messageLog.aggregate({ where: { reviewedAt: { not: null } }, _avg: { reviewRating: true } }),
    // Today's corrections (from all sources)
    db.deferToKetu.count({ where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
    // Recent learnings for "What I learned today" view
    db.deferToKetu.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, buyerQuestion: true, aiWrongReply: true, correctReply: true, createdAt: true },
    }),
    // Recent premium pairs from weekly auto-export (last 14 days so users see the most recent run)
    db.knowledgeChunk.findMany({
      where: { source: 'PREMIUM_PAIR', createdAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, title: true, content: true, metadata: true, createdAt: true },
    }),
  ])

  return c.json({
    enabled: settings.learningEnabled,
    intervalHours: settings.learningIntervalHours,
    lastReviewAt: settings.lastReviewAt,
    dailyCost: { spent: settings.learningDailySpentUsd, budget: settings.learningDailyBudgetUsd },
    premiumExport: {
      enabled: settings.premiumExportEnabled,
      lastRunAt: settings.lastPremiumExportAt,
      nextRunAt: settings.nextPremiumExportAt,
      lastPairs: settings.lastPremiumExportPairs,
    },
    stats: {
      totalCorrections,
      interventionCorrections,  // from Ketu intervening while AI ON
      reviewerCorrections,      // from Sonnet reviewing AI replies
      manualPairCorrections,    // from Sonnet reviewing manual pairs (AI OFF)
      pendingManualPairs,
      totalAiReviewed,
      totalManualReviewed,
      avgRating: avgRating._avg.reviewRating,
      todayCorrections,
    },
    recentLearnings,
    recentPremiumPairs,
  })
})

// Toggle learning on/off
app.put('/api/learning/toggle', async (c) => {
  const { enabled } = await c.req.json()
  await db.settings.update({
    where: { id: 'default' },
    data: { learningEnabled: !!enabled },
  })
  cachedSettings = null
  settingsCacheExpiry = 0
  console.log(`[Learning] ${enabled ? 'Enabled' : 'Disabled'} by user`)
  return c.json({ learningEnabled: !!enabled })
})

// Recent AI reply reviews (for "What went wrong" view)
app.get('/api/learning/reviews', async (c) => {
  const limit = parseInt(c.req.query('limit') || '30')
  const reviews = await db.messageLog.findMany({
    where: { reviewedAt: { not: null } },
    orderBy: { reviewedAt: 'desc' },
    take: limit,
    select: {
      id: true, buyerMessage: true, aiReply: true,
      reviewedAt: true, reviewRating: true, reviewNote: true,
      createdAt: true,
    },
  })
  return c.json(reviews)
})

// Recent manual pair reviews (for "What I learned from your replies" view)
app.get('/api/learning/manual-pairs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '30')
  const pairs = await db.manualReplyPair.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return c.json(pairs)
})

// All pulled pairs (history pull) with summary
app.get('/api/learning/pulled-pairs', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const pageSize = parseInt(c.req.query('pageSize') || '50')
  const category = c.req.query('category') || null
  const result = c.req.query('result') || null // correction_added, ai_would_handle, skipped

  const where = { whatsappNumber: 'history_pull' }
  if (category) where.category = category
  if (result) where.reviewResult = result

  const [pairs, total, summary] = await Promise.all([
    db.manualReplyPair.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.manualReplyPair.count({ where }),
    // Summary stats
    (async () => {
      const baseWhere = { whatsappNumber: 'history_pull' }
      const [totalPulled, reviewed, corrections, aiHandled, skipped, categories] = await Promise.all([
        db.manualReplyPair.count({ where: baseWhere }),
        db.manualReplyPair.count({ where: { ...baseWhere, reviewedAt: { not: null } } }),
        db.manualReplyPair.count({ where: { ...baseWhere, reviewResult: 'correction_added' } }),
        db.manualReplyPair.count({ where: { ...baseWhere, reviewResult: 'ai_would_handle' } }),
        db.manualReplyPair.count({ where: { ...baseWhere, reviewResult: 'skipped' } }),
        db.manualReplyPair.groupBy({
          by: ['category'],
          where: { ...baseWhere, category: { not: null } },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
        }),
      ])
      // Also get corrections per category
      const correctionsByCategory = await db.manualReplyPair.groupBy({
        by: ['category'],
        where: { ...baseWhere, reviewResult: 'correction_added', category: { not: null } },
        _count: { id: true },
      })
      const corrMap = {}
      for (const c of correctionsByCategory) {
        if (c.category) corrMap[c.category] = c._count.id
      }
      return {
        totalPulled, reviewed, corrections, aiHandled, skipped,
        categories: categories.map(c => ({
          name: c.category,
          total: c._count.id,
          corrections: corrMap[c.category] || 0,
        })),
      }
    })(),
  ])

  return c.json({ pairs, total, page, pageSize, summary })
})

// ===========================================
// Dashboard APIs
// ===========================================

// Recent message logs
app.get('/api/logs', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')
  const logs = await db.messageLog.findMany({
    include: { conversation: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  })
  return c.json(logs)
})

// Analytics / aggregate stats
app.get('/api/analytics', async (c) => {
  const period = c.req.query('period') || 'today' // today, 24h, week, month
  const now = new Date()
  let since
  if (period === 'today') {
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  } else if (period === '24h') {
    since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  } else if (period === 'week') {
    since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  } else {
    since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  }

  const [totalMessages, totalReplied, repliedWithCost, totalDeferred, totalSkipped, tokenStats, igPaidCount, igCostAgg] = await Promise.all([
    db.messageLog.count({ where: { createdAt: { gte: since } } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, status: 'REPLIED' } }),
    // REAL paid AI replies only (cost > 0) — excludes the free hardcoded auto-replies (bill->dispatch, welcome)
    db.messageLog.count({ where: { createdAt: { gte: since }, status: 'REPLIED', costUsd: { gt: 0 } } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, status: 'DEFERRED' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, status: 'SKIPPED' } }),
    db.messageLog.aggregate({
      where: { createdAt: { gte: since }, status: 'REPLIED' },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true, costUsd: true },
      _avg: { totalTokens: true, costUsd: true, processingMs: true },
      _max: { costUsd: true },
    }),
    // Instagram sub-stats ('ig:' conversations) — ADDITIVE: every existing field above/below is untouched
    db.messageLog.count({
      where: {
        createdAt: { gte: since }, status: 'REPLIED', costUsd: { gt: 0 },
        conversation: { whatsappNumber: { startsWith: 'ig:' } },
      },
    }),
    db.messageLog.aggregate({
      where: {
        createdAt: { gte: since }, status: 'REPLIED',
        conversation: { whatsappNumber: { startsWith: 'ig:' } },
      },
      _sum: { costUsd: true },
    }),
  ])

  const settings = await getSettings()

  return c.json({
    period,
    since,
    totalMessages,
    totalReplied,
    repliedWithCost,
    totalDeferred,
    totalSkipped,
    interventionRate: totalMessages > 0
      ? ((totalDeferred / totalMessages) * 100).toFixed(1) + '%'
      : '0%',
    tokens: {
      totalInput: tokenStats._sum.promptTokens || 0,
      totalOutput: tokenStats._sum.completionTokens || 0,
      total: tokenStats._sum.totalTokens || 0,
      totalCostUsd: tokenStats._sum.costUsd || 0,
      avgTokensPerReply: Math.round(tokenStats._avg.totalTokens || 0),
      avgCostPerReply: tokenStats._avg.costUsd || 0,
      maxCostPerReply: tokenStats._max.costUsd || 0,
      avgProcessingMs: Math.round(tokenStats._avg.processingMs || 0),
    },
    dailyBudget: {
      limitInr: settings.dailyBudgetInr,
      spentUsd: settings.dailySpentUsd,
      spentInr: settings.dailySpentUsd * 85, // approximate USD to INR
      percentUsed: settings.dailyBudgetInr > 0
        ? (((settings.dailySpentUsd * 85) / settings.dailyBudgetInr) * 100).toFixed(1) + '%'
        : '0%',
    },
    // Instagram DM bridge sub-stats (additive — the wwbun rate strip depends on the fields above)
    instagram: {
      aiPaidCount: igPaidCount,
      totalCostUsd: igCostAgg._sum.costUsd || 0,
      avgCostUsd: igPaidCount > 0 ? (igCostAgg._sum.costUsd || 0) / igPaidCount : 0,
    },
  })
})

// Defer to Ketu list management
app.get('/api/defer-list', async (c) => {
  const items = await db.deferToKetu.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      buyerQuestion: true,
      aiWrongReply: true,
      correctReply: true,
      triggerCount: true,
      createdAt: true,
    }
  })
  return c.json(items)
})

app.delete('/api/defer-list/:id', async (c) => {
  const { id } = c.req.param()
  // Delete from both DeferToKetu and the corresponding KnowledgeChunk (CORRECTION source)
  await Promise.all([
    db.deferToKetu.delete({ where: { id } }),
    db.knowledgeChunk.deleteMany({ where: { source: 'CORRECTION', sourceId: id } }),
  ])
  return c.json({ status: 'deleted' })
})

// Delete a reply template from the knowledge base (by shortcut name)
// Matches either sourceId=shortcut (legacy hardcoded import) OR metadata.shortcut=shortcut (wwbun sync)
app.delete('/api/knowledge/reply-template/:shortcut', async (c) => {
  const { shortcut } = c.req.param()
  const deleted = await db.$executeRaw`
    DELETE FROM "KnowledgeChunk"
    WHERE source = 'SAVED_REPLY'
      AND ("sourceId" = ${shortcut} OR metadata->>'shortcut' = ${shortcut})
  `
  console.log(`[Knowledge] Deleted reply template "/${shortcut}" — ${deleted} chunks removed`)
  return c.json({ status: 'deleted', count: Number(deleted) })
})

// Delete a single bad/stale CORRECTION chunk by id (pruning capture errors / stale stock answers).
// Restricted to source='CORRECTION' so it can never touch CATALOG / SAVED_REPLY data.
app.delete('/api/knowledge/correction/:id', async (c) => {
  const { id } = c.req.param()
  const deleted = await db.$executeRaw`
    DELETE FROM "KnowledgeChunk"
    WHERE source = 'CORRECTION' AND id::text = ${id}
  `
  console.log(`[Knowledge] Deleted CORRECTION ${id} — ${deleted} chunks removed`)
  return c.json({ status: 'deleted', count: Number(deleted) })
})

// ===========================================
// Embedding Management
// ===========================================

// Check transcription status (audio → text via Groq/OpenAI/Sarvam)
app.get('/api/transcription/status', (c) => {
  return c.json({
    configured: isTranscriptionConfigured(),
    provider: getTranscriptionProvider(),
  })
})

// Check embedding status
app.get('/api/embeddings/status', async (c) => {
  const voyageConfigured = isVoyageConfigured()
  const deferCount = await db.deferToKetu.count()
  const chunkCount = await db.knowledgeChunk.count()
  return c.json({
    voyageConfigured,
    embeddingModel: voyageConfigured ? 'voyage-3 (1024 dim)' : 'word-hash (basic)',
    deferItems: deferCount,
    knowledgeChunks: chunkCount,
  })
})

// Re-embed all defer items + knowledge chunks with Voyage AI
app.post('/api/embeddings/re-embed', async (c) => {
  if (!isVoyageConfigured()) {
    return c.json({ error: 'VOYAGE_API_KEY not configured. Add it to Railway env variables.' }, 400)
  }

  try {
    const [deferResult, chunkResult] = await Promise.all([
      reEmbedAllDeferItems(db, anthropic),
      reEmbedAllChunks(db, anthropic),
    ])
    return c.json({
      status: 'done',
      deferItems: deferResult,
      knowledgeChunks: chunkResult,
    })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

// ===========================================
// Pre-AI Filters Stats
// ===========================================

app.get('/api/filters/stats', async (c) => {
  const period = c.req.query('period') || 'today'
  const now = new Date()
  let since
  if (period === 'today') {
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  } else if (period === 'week') {
    since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  } else {
    since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  }

  const settings = await getSettings()

  // Count messages blocked by each filter (deferReason field)
  const [
    offHours,
    dailyLimit,
    emojiReaction,
    mediaOnly,
    billDocument,
    spam,
    cooldown,
    acknowledgment,
    welcomeBypass,
    deferToKetu,
    emptyKb,
    claudeDeferred,
    orderIdDetected,
    angryBuyer,
    informing,
    websiteIssue,
    repeatMessage,
    lowConfidence,
    conversationEnded,
    totalReplied,
    totalMessages,
  ] = await Promise.all([
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'off_hours' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'daily_limit' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'emoji_reaction' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'media_only' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'bill_document' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'spam' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, status: 'COOLDOWN' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'acknowledgment' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'welcome_bypass' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'defer_to_ketu' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'empty_knowledge_base' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'claude_deferred' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'order_id_detected' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'angry_buyer' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'informing' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'website_issue' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'repeat_message' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'low_confidence' } }), // legacy — no longer generated
    db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: 'conversation_ended' } }),
    db.messageLog.count({ where: { createdAt: { gte: since }, status: 'REPLIED', totalTokens: { gt: 0 } } }),
    db.messageLog.count({ where: { createdAt: { gte: since } } }),
  ])

  const totalFiltered = offHours + dailyLimit + emojiReaction + mediaOnly + billDocument + spam + cooldown + acknowledgment + welcomeBypass + emptyKb + orderIdDetected + angryBuyer + informing + websiteIssue + repeatMessage + conversationEnded

  const honorificSuffixes = ['sir', 'ji', 'bhai', 'boss', 'bro', 'sahab', 'saheb', 'g']

  // Load dynamic keyword filters from DB (or use fallback display)
  let dynamicFilterCards = []
  try {
    const dbFilters = await db.preAIFilter.findMany({ orderBy: { priority: 'asc' } })
    if (dbFilters.length > 0) {
      // Count triggers for each dynamic filter by name
      const dynamicCounts = await Promise.all(
        dbFilters.map(f => db.messageLog.count({ where: { createdAt: { gte: since }, deferReason: f.name } }))
      )
      dynamicFilterCards = dbFilters.map((f, i) => ({
        id: f.id,
        dbFilterId: f.id,
        name: f.displayName,
        description: f.description || '',
        type: 'keyword',
        matchType: f.matchType,
        currentState: f.enabled ? `${f.matchType === 'combo' ? 'combo logic' : f.keywords.split(',').filter(Boolean).length + ' keywords'} active` : 'Disabled',
        keywords: f.matchType === 'combo' ? [] : f.keywords.split(',').map(k => k.trim()).filter(Boolean),
        tokens: 0,
        triggered: dynamicCounts[i],
        action: f.action === 'skip' ? 'Skip silently' : f.action === 'defer' ? 'Defer message' : f.action === 'auto_reply' ? `Auto-reply: "${(f.autoReplyText || '').substring(0, 40)}"` : 'Welcome bypass',
        enabled: f.enabled,
        isSystem: f.isSystem,
        filterAction: f.action,
        autoReplyText: f.autoReplyText,
      }))
    }
  } catch {
    // DB not ready, dynamicFilterCards stays empty
  }

  // System filters (hardcoded, not editable)
  const systemFilters = [
    {
      id: 'system_active',
      name: 'System ON/OFF',
      description: 'AI is turned OFF — all messages skipped',
      type: 'system',
      currentState: settings.isActive ? 'Active (AI ON)' : 'Inactive (AI OFF)',
      tokens: 0,
      triggered: offHours,
      action: 'Skip silently',
    },
    {
      id: 'schedule',
      name: 'Working Hours',
      description: `Only process messages during ${settings.scheduleStart || 'N/A'} - ${settings.scheduleEnd || 'N/A'} IST`,
      type: 'system',
      currentState: settings.scheduleEnabled ? `${settings.scheduleStart} - ${settings.scheduleEnd}` : 'Disabled',
      tokens: 0,
      triggered: offHours,
      action: 'Skip silently',
    },
    {
      id: 'daily_budget',
      name: 'Daily Budget Limit',
      description: `Stop AI when daily spend reaches Rs ${settings.dailyBudgetInr}`,
      type: 'system',
      currentState: `Rs ${(settings.dailySpentUsd * 85).toFixed(0)} / Rs ${settings.dailyBudgetInr}`,
      tokens: 0,
      triggered: dailyLimit,
      action: 'Skip silently',
    },
    {
      id: 'emoji_reaction',
      name: 'Emoji Reactions',
      description: 'Skip reactions like thumbs up, heart, etc.',
      type: 'message',
      currentState: 'Always active',
      tokens: 0,
      triggered: emojiReaction,
      action: 'Skip silently',
    },
    {
      id: 'media_only',
      name: 'Media-Only Messages',
      description: 'Auto-reply to images, audio, video, documents',
      type: 'message',
      currentState: `Reply: "${settings.mediaMessage || 'N/A'}"`,
      tokens: 0,
      triggered: mediaOnly,
      action: 'Auto-reply (media message)',
    },
    {
      id: 'bill_document',
      name: 'BillNo PDF Detection',
      description: 'Detect invoice PDFs (BillNo*.pdf) and auto-acknowledge dispatch',
      type: 'keyword',
      currentState: 'Regex: [Document:.*BillNo.*\\.pdf]',
      tokens: 0,
      triggered: billDocument,
      action: 'Auto-reply: "Ok noted sir, dispatching ASAP"',
    },
    {
      id: 'empty_message',
      name: 'Empty / Spam Messages',
      description: 'Skip messages with no text content',
      type: 'message',
      currentState: 'Always active',
      tokens: 0,
      triggered: spam,
      action: 'Skip silently',
    },
    {
      id: 'cooldown',
      name: 'Manual Intervention Cooldown',
      description: `AI pauses for ${settings.cooldownMinutes} min after you reply manually`,
      type: 'user',
      currentState: `${settings.cooldownMinutes} min cooldown`,
      tokens: 0,
      triggered: cooldown,
      action: 'Skip silently',
    },
    {
      id: 'repeat_message',
      name: 'Repeat Message Detection',
      description: 'Skip if same buyer sent the exact same message within 5 minutes and AI already replied',
      type: 'message',
      currentState: '5 min window',
      tokens: 0,
      triggered: repeatMessage,
      action: 'Skip silently (already replied)',
    },
  ]

  // Post-filter items (not keyword-based)
  const postFilters = [
    {
      id: 'welcome_bypass',
      name: 'Welcome Message Bypass',
      description: 'First-time buyer or returning after 7+ days → send welcome directly',
      type: 'auto-reply',
      currentState: 'Active (7-day gap)',
      tokens: 0,
      triggered: welcomeBypass,
      action: 'Auto-reply with welcome message',
    },
    {
      id: 'order_id_detected',
      name: 'Order ID / Tracking Number',
      description: 'Detect long numeric strings (10+ digits) as order/tracking IDs and defer immediately',
      type: 'keyword',
      currentState: 'Regex: ^\\d{10,}$',
      tokens: 0,
      triggered: orderIdDetected,
      action: 'Defer message (0 tokens)',
    },
    {
      id: 'empty_kb',
      name: 'Empty Knowledge Base',
      description: 'If no knowledge synced yet, defer all messages',
      type: 'system',
      currentState: 'Safety check',
      tokens: 0,
      triggered: emptyKb,
      action: 'Defer message',
    },
    {
      id: 'claude_deferred',
      name: 'Claude [DEFER]',
      description: 'Claude decides it cannot answer — defers to Ketu',
      type: 'post-ai',
      currentState: 'Active',
      tokens: 'Yes (Claude called first)',
      triggered: claudeDeferred,
      action: 'Send defer message to buyer',
    },
    {
      id: 'conversation_ended',
      name: 'Claude [SKIP]',
      description: 'Claude detects conversation ender (thanks, bye, ok done) — silently skips',
      type: 'post-ai',
      currentState: 'Active',
      tokens: 'Yes (Claude called first)',
      triggered: conversationEnded,
      action: 'Silent skip + auto-learn to pre-AI filter',
    },
  ]

  return c.json({
    period,
    since,
    totalMessages,
    totalFiltered,
    totalReachedClaude: totalReplied + claudeDeferred,
    honorificSuffixes,
    filters: [
      ...systemFilters,
      ...dynamicFilterCards,
      ...postFilters,
    ],
  })
})

// ===========================================
// Pre-AI Filter Management (CRUD)
// ===========================================

import { clearFilterCache } from './process.js'

// Get all filters
app.get('/api/filters', async (c) => {
  try {
    const filters = await db.preAIFilter.findMany({ orderBy: { priority: 'asc' } })
    return c.json(filters)
  } catch {
    return c.json([])
  }
})

// Update filter (toggle enabled, change autoReplyText, etc.)
app.put('/api/filters/:id', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  // Only allow safe fields to be updated
  const allowed = ['enabled', 'displayName', 'description', 'autoReplyText', 'matchType', 'action', 'priority']
  const updates = {}
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key]
  }
  const filter = await db.preAIFilter.update({ where: { id }, data: updates })
  clearFilterCache()
  return c.json(filter)
})

// Add keyword to filter
app.post('/api/filters/:id/keywords', async (c) => {
  const { id } = c.req.param()
  const { keyword } = await c.req.json()
  if (!keyword || !keyword.trim()) return c.json({ error: 'Keyword required' }, 400)

  const filter = await db.preAIFilter.findUnique({ where: { id } })
  if (!filter) return c.json({ error: 'Filter not found' }, 404)

  const existing = filter.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
  if (existing.includes(keyword.trim().toLowerCase())) {
    return c.json({ error: 'Keyword already exists' }, 400)
  }

  const updatedKeywords = filter.keywords
    ? filter.keywords + ',' + keyword.trim().toLowerCase()
    : keyword.trim().toLowerCase()

  await db.preAIFilter.update({ where: { id }, data: { keywords: updatedKeywords } })
  clearFilterCache()
  return c.json({ ok: true })
})

// Remove keyword from filter
app.delete('/api/filters/:id/keywords/:keyword', async (c) => {
  const { id, keyword } = c.req.param()
  const filter = await db.preAIFilter.findUnique({ where: { id } })
  if (!filter) return c.json({ error: 'Filter not found' }, 404)

  const keywords = filter.keywords.split(',').map(k => k.trim()).filter(k => k.toLowerCase() !== decodeURIComponent(keyword).toLowerCase())
  await db.preAIFilter.update({ where: { id }, data: { keywords: keywords.join(',') } })
  clearFilterCache()
  return c.json({ ok: true })
})

// Create new filter (from discovered category)
app.post('/api/filters', async (c) => {
  const body = await c.req.json()
  if (!body.name || !body.displayName) return c.json({ error: 'name and displayName required' }, 400)

  // Sanitize name to snake_case
  const name = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

  const filter = await db.preAIFilter.create({
    data: {
      name,
      displayName: body.displayName,
      description: body.description || null,
      filterType: 'keyword',
      matchType: body.matchType || 'partial',
      action: body.action || 'skip',
      autoReplyText: body.autoReplyText || null,
      keywords: body.keywords || '',
      enabled: true,
      isSystem: false,
      priority: body.priority || 100,
    },
  })
  clearFilterCache()
  return c.json(filter)
})

// Delete a user-created filter (not system filters)
app.delete('/api/filters/:id', async (c) => {
  const { id } = c.req.param()
  const filter = await db.preAIFilter.findUnique({ where: { id } })
  if (!filter) return c.json({ error: 'Filter not found' }, 404)
  if (filter.isSystem) return c.json({ error: 'Cannot delete system filters' }, 400)

  await db.preAIFilter.delete({ where: { id } })
  clearFilterCache()
  return c.json({ ok: true })
})

// ===========================================
// Discovered Keywords (from AI learning)
// ===========================================

// Get pending + recently auto-added
app.get('/api/filters/discovered', async (c) => {
  try {
    const [pending, autoAdded] = await Promise.all([
      db.discoveredKeyword.findMany({
        where: { status: 'pending' },
        orderBy: { discoveredAt: 'desc' },
      }),
      db.discoveredKeyword.findMany({
        where: {
          status: 'auto_added',
          processedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { processedAt: 'desc' },
      }),
    ])
    return c.json({ pending, autoAdded })
  } catch {
    return c.json({ pending: [], autoAdded: [] })
  }
})

// Approve discovered keyword → add to filter
app.post('/api/filters/discovered/:id/approve', async (c) => {
  const { id } = c.req.param()
  const { filterId } = await c.req.json()

  const discovered = await db.discoveredKeyword.findUnique({ where: { id } })
  if (!discovered) return c.json({ error: 'Not found' }, 404)

  // Add keyword to the target filter
  const filter = await db.preAIFilter.findUnique({ where: { id: filterId } })
  if (!filter) return c.json({ error: 'Filter not found' }, 404)

  const existing = filter.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
  if (!existing.includes(discovered.keyword.toLowerCase())) {
    const updatedKeywords = filter.keywords
      ? filter.keywords + ',' + discovered.keyword.toLowerCase()
      : discovered.keyword.toLowerCase()
    await db.preAIFilter.update({ where: { id: filterId }, data: { keywords: updatedKeywords } })
  }

  await db.discoveredKeyword.update({
    where: { id },
    data: { status: 'approved', filterId, processedAt: new Date() },
  })

  clearFilterCache()
  return c.json({ ok: true })
})

// Dismiss discovered keyword
app.post('/api/filters/discovered/:id/dismiss', async (c) => {
  const { id } = c.req.param()
  await db.discoveredKeyword.update({
    where: { id },
    data: { status: 'dismissed', processedAt: new Date() },
  })
  return c.json({ ok: true })
})

// AI-discover keywords for a specific filter category
app.post('/api/filters/:id/ai-discover', async (c) => {
  const { id } = c.req.param()
  const filter = await db.preAIFilter.findUnique({ where: { id } })
  if (!filter) return c.json({ error: 'Filter not found' }, 404)

  // Get recent pairs of this category
  const pairs = await db.manualReplyPair.findMany({
    where: { category: filter.name },
    take: 100,
    orderBy: { createdAt: 'desc' },
  })

  if (pairs.length < 3) {
    return c.json({ error: 'Not enough data yet', count: pairs.length, needed: 3 })
  }

  const currentKeywords = filter.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)

  const prompt = `You analyze buyer messages from a wholesale blank t-shirt business (BulkPlainTshirt.com).

These messages belong to the "${filter.displayName}" category (action: ${filter.action}).

Current keywords already in this filter: ${currentKeywords.join(', ') || 'none'}

Buyer messages in this category:
${pairs.map(p => `- "${p.buyerMessage}"`).join('\n')}

Extract SHORT keywords/phrases (1-3 words, Hindi/English/Hinglish) that could detect similar messages.
- Only include keywords NOT already in the current list
- Must be specific enough to avoid false positives
- Assign confidence 0.0-1.0 (0.9+ = very sure, 0.7-0.89 = fairly sure, below 0.7 = uncertain)

Reply as JSON array only: [{ "keyword": "...", "confidence": 0.95 }]`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  })

  let newKeywords
  try {
    const text = response.content[0].text
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    newKeywords = JSON.parse(jsonMatch ? jsonMatch[0] : text)
  } catch {
    return c.json({ error: 'Failed to parse AI response' }, 500)
  }

  let autoAddedCount = 0
  let pendingCount = 0

  for (const kw of newKeywords) {
    if (!kw.keyword || currentKeywords.includes(kw.keyword.toLowerCase())) continue

    const isHighConfidence = kw.confidence >= 0.85

    await db.discoveredKeyword.create({
      data: {
        keyword: kw.keyword.toLowerCase(),
        category: filter.name,
        confidence: kw.confidence,
        source: 'manual_review',
        status: isHighConfidence ? 'auto_added' : 'pending',
        filterId: isHighConfidence ? filter.id : null,
        processedAt: isHighConfidence ? new Date() : null,
      },
    })

    if (isHighConfidence) {
      // Auto-add to filter
      const updatedKeywords = filter.keywords
        ? filter.keywords + ',' + kw.keyword.toLowerCase()
        : kw.keyword.toLowerCase()
      await db.preAIFilter.update({ where: { id: filter.id }, data: { keywords: updatedKeywords } })
      filter.keywords = updatedKeywords // Update local copy for next iteration
      currentKeywords.push(kw.keyword.toLowerCase())
      autoAddedCount++
    } else {
      pendingCount++
    }
  }

  clearFilterCache()
  return c.json({
    total: newKeywords.length,
    autoAdded: autoAddedCount,
    pending: pendingCount,
    message: `Found ${newKeywords.length} keywords: ${autoAddedCount} auto-added, ${pendingCount} need your review`,
  })
})

// ===========================================
// Knowledge Base Browsing (Vector DB contents)
// ===========================================

// Stats: how many chunks per source type
app.get('/api/knowledge/stats', async (c) => {
  try {
    const [bySource, embeddingCounts, deferCount] = await Promise.all([
      db.knowledgeChunk.groupBy({
        by: ['source'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      // Use raw SQL for embedding column (Unsupported type can't be filtered by Prisma)
      db.$queryRaw`SELECT COUNT(*) FILTER (WHERE embedding IS NOT NULL) as "withEmbedding", COUNT(*) FILTER (WHERE embedding IS NULL) as "withoutEmbedding" FROM "KnowledgeChunk"`,
      db.deferToKetu.count(),
    ])

    const sources = {}
    for (const s of bySource) {
      sources[s.source] = s._count.id
    }

    return c.json({
      total: Object.values(sources).reduce((a, b) => a + b, 0),
      withEmbedding: Number(embeddingCounts[0]?.withEmbedding || 0),
      withoutEmbedding: Number(embeddingCounts[0]?.withoutEmbedding || 0),
      deferToKetuItems: deferCount,
      sources,
    })
  } catch (err) {
    console.error('[Knowledge Stats] Error:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

// Browse chunks by source type (paginated)
app.get('/api/knowledge/chunks', async (c) => {
  const source = c.req.query('source') || null
  const page = parseInt(c.req.query('page') || '1')
  const pageSize = parseInt(c.req.query('pageSize') || '50')
  const search = c.req.query('search') || null

  const where = {}
  if (source) where.source = source
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { content: { contains: search, mode: 'insensitive' } },
    ]
  }

  const [chunks, total] = await Promise.all([
    db.knowledgeChunk.findMany({
      where,
      select: { id: true, source: true, sourceId: true, title: true, content: true, metadata: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.knowledgeChunk.count({ where }),
  ])

  return c.json({ chunks, total, page, pageSize })
})

// Knowledge base download
app.get('/api/knowledge/download', async (c) => {
  const [chunks, deferList, settings] = await Promise.all([
    db.knowledgeChunk.findMany({
      select: { id: true, source: true, sourceId: true, title: true, content: true, metadata: true, createdAt: true, updatedAt: true },
      orderBy: { source: 'asc' },
    }),
    db.deferToKetu.findMany({
      select: { buyerQuestion: true, correctReply: true, createdAt: true },
    }),
    getSettings(),
  ])

  const knowledgeBase = {
    exportedAt: new Date().toISOString(),
    totalChunks: chunks.length,
    chunks: chunks.reduce((acc, chunk) => {
      const key = chunk.source
      if (!acc[key]) acc[key] = []
      acc[key].push({
        title: chunk.title,
        content: chunk.content,
        metadata: chunk.metadata,
        updatedAt: chunk.updatedAt,
      })
      return acc
    }, {}),
    deferToKetuList: deferList,
    settings: {
      confidenceThreshold: settings.confidenceThreshold,
      deferMessage: settings.deferMessage,
      mediaMessage: settings.mediaMessage,
    },
  }

  c.header('Content-Disposition', 'attachment; filename="knowledge-base.json"')
  return c.json(knowledgeBase)
})

// ===========================================
// Sync Endpoints
// ===========================================

app.post('/api/sync/saved-replies', async (c) => {
  try {
    const result = await syncSavedReplies(db, anthropic)
    return c.json(result)
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

app.post('/api/sync/catalog', async (c) => {
  try {
    const result = await syncCatalog(db, anthropic)
    return c.json(result)
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

// Note: /api/sync/import-reply-templates and /api/sync/import-style-pairs were removed.
// Reply templates are synced from wwbun's DB via /api/sync/saved-replies.
// Style pairs are populated by the weekly Premium Export (PREMIUM_PAIR source).
// The 337 existing STYLE_PAIR chunks remain in the DB as a legacy baseline.

app.post('/api/sync/style-pairs', async (c) => {
  try {
    const result = await syncStylePairs(db, anthropic)
    return c.json(result)
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

app.post('/api/sync/all', async (c) => {
  try {
    const [replies, catalog] = await Promise.all([
      syncSavedReplies(db, anthropic),
      syncCatalog(db, anthropic),
    ])
    // Update last sync time
    await db.settings.update({
      where: { id: 'default' },
      data: {
        lastSyncAt: new Date(),
        nextSyncAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days
      },
    })
    return c.json({ savedReplies: replies, catalog })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

// Sync log history
app.get('/api/sync/logs', async (c) => {
  const logs = await db.syncLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  return c.json(logs)
})

// Training history — premium_export runs with full details
app.get('/api/training/history', async (c) => {
  const logs = await db.syncLog.findMany({
    where: { syncType: 'premium_export' },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return c.json(logs)
})

// ===========================================
// Scheduled Sync (every 3 days)
// ===========================================

async function runScheduledSync() {
  // Force sync if knowledge base is empty (first deploy or after DB reset)
  const chunkCount = await db.knowledgeChunk.count()
  if (chunkCount === 0) {
    console.log('[Sync] Knowledge base is EMPTY — forcing initial sync...')
  } else {
    const settings = await getSettings()
    if (settings.nextSyncAt && new Date() < new Date(settings.nextSyncAt)) return
  }

  console.log('[Sync] Running scheduled sync...')
  try {
    await syncSavedReplies(db, anthropic)
    await syncCatalog(db, anthropic)
    // Style pairs handled by weekly Premium Export (Opus quality filtering)
    await db.settings.update({
      where: { id: 'default' },
      data: {
        lastSyncAt: new Date(),
        nextSyncAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    })
    const newCount = await db.knowledgeChunk.count()
    console.log(`[Sync] Scheduled sync complete — ${newCount} knowledge chunks now in DB`)
  } catch (err) {
    console.error('[Sync] Scheduled sync failed:', err.message)
  }
}

// Check every 6 hours if sync is due (actual sync cadence is 3 days, stored in settings.nextSyncAt)
setInterval(runScheduledSync, 6 * 60 * 60 * 1000)

// ===========================================
// Weekly Premium Export Scheduler
// ===========================================

async function runScheduledPremiumExport() {
  try {
    const settings = await getSettings()
    if (!settings.premiumExportEnabled) return

    // Check if it's time to export
    if (settings.nextPremiumExportAt && new Date() < new Date(settings.nextPremiumExportAt)) return

    console.log('[PremiumExport] Running scheduled weekly premium export...')
    const result = await executePremiumExport(settings)
    console.log(`[PremiumExport] Complete — ${result.imported} pairs imported into knowledge base`)
  } catch (err) {
    console.error('[PremiumExport] Scheduled export failed:', err.message)
  }
}

// Background job state for premium export
let premiumExportJob = { running: false, result: null, error: null, startedAt: null }

async function executePremiumExport(settings) {
  const startTime = Date.now()
  const WWBUN_API_URL = settings.wwbunApiUrl || process.env.WWBUN_API_URL
  const DIGITAL_KETU_SECRET = settings.digitalKetuSecret || process.env.DIGITAL_KETU_SECRET

  if (!WWBUN_API_URL || !DIGITAL_KETU_SECRET) {
    throw new Error('WWBUN_API_URL or DIGITAL_KETU_SECRET not configured')
  }

  // Date range: last export to now (or last 7 days if first run)
  const intervalDays = settings.premiumExportIntervalDays || 7
  const fromDate = settings.lastPremiumExportAt
    ? new Date(settings.lastPremiumExportAt).toISOString().split('T')[0]
    : new Date(Date.now() - intervalDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const toDate = new Date().toISOString().split('T')[0]

  // Step 1: Fetch mechanical pairs from wwbun
  const url = `${WWBUN_API_URL}/api/messages/export-style-pairs?limit=5000&fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`
  const response = await fetch(url, {
    headers: { 'X-Digital-Ketu-Secret': DIGITAL_KETU_SECRET },
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`wwbun API error: ${response.status} — ${errText}`)
  }

  const wwbunData = await response.json()
  // wwbun now returns { pairs, filterStats } object — handle both old array and new format
  const mechanicalPairs = Array.isArray(wwbunData) ? wwbunData : (wwbunData.pairs || [])
  const wwbunFilterStats = wwbunData.filterStats || null
  const wwbunDbDiagnostics = wwbunData.dbDiagnostics || null
  const wwbunRejectedSamples = wwbunData.rejectedSamples || null
  console.log(`[PremiumExport] Fetched ${mechanicalPairs.length} mechanical pairs (${fromDate} to ${toDate})`)
  if (wwbunFilterStats) console.log(`[PremiumExport] wwbun filter stats:`, JSON.stringify(wwbunFilterStats))
  if (wwbunDbDiagnostics) console.log(`[PremiumExport] wwbun DB diagnostics:`, JSON.stringify(wwbunDbDiagnostics))

  if (mechanicalPairs.length === 0) {
    const detailsObj = { fromDate, toDate, filterStats: wwbunFilterStats, dbDiagnostics: wwbunDbDiagnostics, rejectedSamples: wwbunRejectedSamples, keptPairs: [], claudeRejected: [] }
    const log = await db.syncLog.create({
      data: { syncType: 'premium_export', status: 'success', itemsFound: 0, itemsNew: 0, itemsUpdated: 0, durationMs: Date.now() - startTime },
    })
    await db.syncLog.update({ where: { id: log.id }, data: { details: detailsObj } }).catch(err => console.error('[PremiumExport] Failed to store details:', err.message))
    await db.settings.update({
      where: { id: 'default' },
      data: {
        lastPremiumExportAt: new Date(),
        nextPremiumExportAt: new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000),
        lastPremiumExportPairs: 0,
      },
    })
    return { imported: 0, total: 0, skipped: 0, fromDate, toDate, wwbunFilterStats, wwbunDbDiagnostics, wwbunRejectedSamples }
  }

  // Step 2: Opus 4.6 judges Rules 3 & 4
  const classifications = await classifyPairsWithClaude(mechanicalPairs)

  const kept = []
  const claudeRejected = []
  for (const cls of classifications) {
    const pair = mechanicalPairs[cls.index]
    if (!pair) continue
    if (cls.verdict === 'KEEP') {
      kept.push({ ...pair, classifyReason: cls.reason })
    } else {
      claudeRejected.push({ buyerMessage: pair.buyerMessage.slice(0, 150), omReply: pair.omReply.slice(0, 150), reason: cls.reason })
    }
  }

  console.log(`[PremiumExport] Opus classified: ${kept.length} KEEP, ${mechanicalPairs.length - kept.length} SKIP`)

  // Step 3: Import KEEP pairs into KnowledgeChunk as PREMIUM_PAIR
  let imported = 0
  for (const pair of kept) {
    try {
      // Use hash of buyer message as sourceId for de-duplication
      const sourceId = `premium_${Buffer.from(pair.buyerMessage).toString('base64url').substring(0, 40)}`
      const content = `Buyer: ${pair.buyerMessage}\nOm: ${pair.omReply}`
      const title = pair.buyerMessage.substring(0, 80)

      await storeChunkWithEmbedding(db, anthropic, {
        source: 'PREMIUM_PAIR',
        sourceId,
        title,
        content,
        metadata: {
          buyerMessage: pair.buyerMessage,
          omReply: pair.omReply,
          classifyReason: pair.classifyReason,
          exportedAt: new Date().toISOString(),
        },
      })
      imported++
    } catch (err) {
      console.error(`[PremiumExport] Failed to import pair: ${err.message}`)
    }
  }

  const durationMs = Date.now() - startTime

  // Step 4: Log and update settings
  const detailsObj = {
    fromDate, toDate,
    filterStats: wwbunFilterStats || {},
    dbDiagnostics: wwbunDbDiagnostics || {},
    rejectedSamples: wwbunRejectedSamples || {},
    keptPairs: kept.map(p => ({ buyerMessage: p.buyerMessage.slice(0, 200), omReply: p.omReply.slice(0, 200), classifyReason: p.classifyReason })),
    claudeRejected,
  }
  const syncLog = await db.syncLog.create({
    data: {
      syncType: 'premium_export',
      status: 'success',
      itemsFound: mechanicalPairs.length,
      itemsNew: imported,
      itemsUpdated: 0,
      durationMs,
    },
  })
  // Store details separately (workaround for Prisma Json field on create)
  await db.syncLog.update({ where: { id: syncLog.id }, data: { details: detailsObj } }).catch(err => console.error('[PremiumExport] Failed to store details:', err.message))
  console.log(`[PremiumExport] SyncLog ${syncLog.id} created, details stored: ${JSON.stringify(detailsObj).length} bytes`)

  await db.settings.update({
    where: { id: 'default' },
    data: {
      lastPremiumExportAt: new Date(),
      nextPremiumExportAt: new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000),
      lastPremiumExportPairs: imported,
    },
  })

  console.log(`[PremiumExport] ${imported} pairs imported in ${(durationMs / 1000).toFixed(1)}s`)
  return { imported, total: mechanicalPairs.length, skipped: mechanicalPairs.length - kept.length, fromDate, toDate, wwbunFilterStats, wwbunDbDiagnostics, wwbunRejectedSamples }
}

// Check every 6 hours if premium export is due (actual cadence is ~7 days, stored in settings.nextPremiumExportAt)
setInterval(runScheduledPremiumExport, 6 * 60 * 60 * 1000)

// Manual trigger endpoint — starts export in background to avoid Railway timeouts
app.post('/api/premium-export/run', async (c) => {
  if (premiumExportJob.running) {
    return c.json({ status: 'running', message: 'Training is already in progress', startedAt: premiumExportJob.startedAt })
  }
  try {
    const body = await c.req.json().catch(() => ({}))
    const settings = await getSettings()
    if (body.fromDate) {
      settings.lastPremiumExportAt = new Date(body.fromDate)
    }
    // Start in background — don't await
    premiumExportJob = { running: true, result: null, error: null, startedAt: new Date().toISOString() }
    executePremiumExport(settings)
      .then(result => {
        premiumExportJob = { running: false, result, error: null, startedAt: premiumExportJob.startedAt }
        console.log('[PremiumExport] Background job completed successfully')
      })
      .catch(err => {
        premiumExportJob = { running: false, result: null, error: err.message, startedAt: premiumExportJob.startedAt }
        console.error('[PremiumExport] Background job failed:', err.message)
      })
    return c.json({ status: 'started', message: 'Training started in background' })
  } catch (err) {
    console.error('[PremiumExport] Manual trigger failed:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

// Poll for premium export job status
app.get('/api/premium-export/status', (c) => {
  if (premiumExportJob.running) {
    return c.json({ status: 'running', startedAt: premiumExportJob.startedAt })
  }
  if (premiumExportJob.error) {
    const error = premiumExportJob.error
    premiumExportJob = { running: false, result: null, error: null, startedAt: null }
    return c.json({ status: 'failed', error })
  }
  if (premiumExportJob.result) {
    const result = premiumExportJob.result
    premiumExportJob = { running: false, result: null, error: null, startedAt: null }
    return c.json({ status: 'success', ...result })
  }
  return c.json({ status: 'idle' })
})

// ===========================================
// Self-Learning Scheduler
// ===========================================

// Per daily run, loop up to this many 20-pair batches. Sized for ~400 pair/day capture
// plus backlog burn-down within budget (~70% of learningDailyBudgetUsd).
// Loop breaks early when queues empty or budget cap hit.
const SCHEDULED_REVIEW_MAX_BATCHES = 30
const SCHEDULED_REVIEW_BUDGET_FRACTION = 0.70

async function runScheduledReview() {
  try {
    const settings = await getSettings()
    if (!settings.learningEnabled) return

    // Check if enough time has passed since last review (cadence lives in learningIntervalHours)
    // In Partial AI mode (AI off but partial on), run weekly (168h) to save Neon CU-hours;
    // full AI on uses the configured learningIntervalHours (default 168h, but user-configurable).
    const effectiveInterval = (!settings.isActive && settings.partialAiEnabled) ? 168 : settings.learningIntervalHours
    if (settings.lastReviewAt) {
      const hoursSince = (Date.now() - new Date(settings.lastReviewAt).getTime()) / (1000 * 60 * 60)
      if (hoursSince < effectiveInterval) return
    }

    // Daily-spend reset now happens in getSettings() — settings.learningDailySpentUsd
    // is already current-day as of this fetch.

    // Check daily budget
    if (settings.learningDailySpentUsd >= settings.learningDailyBudgetUsd) {
      console.log('[Learning] Daily budget reached, skipping review')
      return
    }

    // Cap this run at 70% of remaining daily budget so ad-hoc "Run Now" clicks still have headroom
    const remainingBudget = settings.learningDailyBudgetUsd - settings.learningDailySpentUsd
    const budgetCapUsd = Math.max(remainingBudget * SCHEDULED_REVIEW_BUDGET_FRACTION, 0)

    console.log(`[Learning] Running scheduled daily review (up to ${SCHEDULED_REVIEW_MAX_BATCHES} batches, $${budgetCapUsd.toFixed(4)} budget)...`)
    const result = await runReviewJob(db, {
      maxBatches: SCHEDULED_REVIEW_MAX_BATCHES,
      budgetCapUsd,
    })

    await db.settings.update({
      where: { id: 'default' },
      data: {
        lastReviewAt: new Date(),
        learningDailySpentUsd: { increment: result.totalCostUsd },
      },
    })
    // Invalidate cache so the fresh spend counter is visible to next callers
    cachedSettings = null
    settingsCacheExpiry = 0

    const totalCorrections = result.aiReplies.corrections + result.manualPairs.corrections
    const totalReviewed = result.aiReplies.reviewed + result.manualPairs.reviewed
    console.log(`[Learning] Daily review complete — ${result.batchesRun} batches, ${totalReviewed} pairs reviewed, ${totalCorrections} corrections, $${result.totalCostUsd.toFixed(4)} cost`)
  } catch (err) {
    console.error('[Learning] Scheduled review failed:', err.message)
  }
}

// Poll every 6h; runScheduledReview internally gates on learningIntervalHours (default weekly = 168h)
setInterval(runScheduledReview, 6 * 60 * 60 * 1000)

// ===========================================
// Export Premium Pairs (Rules 1-4) — Claude AI Classification
// ===========================================

const PAIRS_CLASSIFY_PROMPT = `You are classifying WhatsApp message pairs from a wholesale blank t-shirt business (BulkPlainTshirt.com / sale91.com). The owner "Om/Ketu" replies to buyer questions.

For each pair, classify as KEEP or SKIP based on TWO rules:

**Rule 3 — Non-Context Only (SKIP if context-based):**
SKIP pairs where the buyer's question references a PREVIOUS conversation, specific order, or ongoing situation that an AI wouldn't have context for. Examples:
- "My order hasn't arrived yet" (references specific order)
- "Any update?" (references prior discussion)
- "Send the bill" (specific order action)
- "Wo charcoal wala" (referencing something discussed before)
- Sharing addresses, payment screenshots, order IDs
- Om saying "nikal diya" / "bhej diya" (confirming specific order action)
- Logistics coordination with specific people, times, bike numbers

**Rule 4 — Permanent Only (SKIP if temporary):**
SKIP pairs where Om's answer will become WRONG over time. Examples:
- "Is charcoal available?" → "No, after 15 days" (stock changes)
- "Kab tak aayega?" → "2-3 din mein" (time-bound)
- "Currently out of stock" (changes daily)
- Business closed/holiday status (temporary)
KEEP pairs where the answer is ALWAYS TRUE:
- "Do you sell kurti?" → "No, only plain tshirts" (permanent fact)
- "MOQ kitna hai?" → "10 pcs for bulk" (permanent policy)
- Business hours, payment methods, factory location, policies

Reply as a JSON array with one object per pair:
[{"index": 0, "verdict": "KEEP", "reason": "permanent policy about MOQ"}, {"index": 1, "verdict": "SKIP", "reason": "asking about specific order status"}, ...]

Be strict. When in doubt, SKIP. Only KEEP pairs that are clearly standalone + permanently true.`

async function classifyPairsWithClaude(pairs) {
  const BATCH_SIZE = 50
  const allResults = []

  for (let start = 0; start < pairs.length; start += BATCH_SIZE) {
    const batch = pairs.slice(start, start + BATCH_SIZE)
    const batchText = batch.map((p, i) => `[${start + i}] BUYER: "${p.buyerMessage}"\nOM: "${p.omReply}"`).join('\n\n')

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: PAIRS_CLASSIFY_PROMPT,
      messages: [{ role: 'user', content: `Classify these ${batch.length} pairs:\n\n${batchText}` }],
    })

    const text = response.content[0].text
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const results = JSON.parse(jsonMatch[0])
      allResults.push(...results)
    }
  }

  return allResults
}

app.post('/api/export/premium-pairs', async (c) => {
  try {
    const { fromDate, toDate } = await c.req.json()
    if (!fromDate || !toDate) {
      return c.json({ error: 'fromDate and toDate are required' }, 400)
    }

    const settings = await getSettings()
    const WWBUN_API_URL = settings.wwbunApiUrl || process.env.WWBUN_API_URL
    const DIGITAL_KETU_SECRET = settings.digitalKetuSecret || process.env.DIGITAL_KETU_SECRET

    if (!WWBUN_API_URL || !DIGITAL_KETU_SECRET) {
      return c.json({ error: 'WWBUN_API_URL or DIGITAL_KETU_SECRET not configured' }, 500)
    }

    // Step 1: Fetch pairs from wwbun with date range (Rules 1 & 2 applied by wwbun)
    const url = `${WWBUN_API_URL}/api/messages/export-style-pairs?limit=5000&fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`
    const response = await fetch(url, {
      headers: { 'X-Digital-Ketu-Secret': DIGITAL_KETU_SECRET },
    })

    if (!response.ok) {
      const errText = await response.text()
      return c.json({ error: `wwbun API error: ${response.status} — ${errText}` }, 502)
    }

    const wwbunData = await response.json()
    const mechanicalPairs = Array.isArray(wwbunData) ? wwbunData : (wwbunData.pairs || [])
    console.log(`[Export] Fetched ${mechanicalPairs.length} mechanical pairs, sending to Claude for Rules 3&4...`)
    if (wwbunData.filterStats) console.log(`[Export] wwbun filter stats:`, JSON.stringify(wwbunData.filterStats))

    // Step 2: Send to Claude Opus for Rules 3 & 4 classification
    const classifications = await classifyPairsWithClaude(mechanicalPairs)

    const kept = []
    const skipped = []
    for (const cls of classifications) {
      const pair = mechanicalPairs[cls.index]
      if (!pair) continue
      if (cls.verdict === 'KEEP') {
        kept.push({ ...pair, classifyReason: cls.reason })
      } else {
        skipped.push({ ...pair, classifyReason: cls.reason })
      }
    }

    console.log(`[Export] Claude classified: ${kept.length} KEEP, ${skipped.length} SKIP`)

    // Step 3: Build text export
    const header = `PREMIUM STYLE PAIRS EXPORT — BulkPlainTshirt.com\n` +
      `${'='.repeat(70)}\n` +
      `Exported: ${new Date().toISOString()}\n` +
      `Date range: ${fromDate} to ${toDate}\n` +
      `Total premium pairs: ${kept.length} (${mechanicalPairs.length} mechanical, ${skipped.length} skipped by Claude)\n` +
      `Classified by: Claude Opus (latest)\n` +
      `Rules applied:\n` +
      `  1. Thought bundling (messages within 5s = one thought) [wwbun]\n` +
      `  2. Quality: 4+ words on both buyer & seller side [wwbun]\n` +
      `  3. Non-context only — Claude AI judged [Claude Opus]\n` +
      `  4. Permanent only — Claude AI judged [Claude Opus]\n` +
      `  + De-duplicated, skip media/URLs/greetings/acks [wwbun]\n` +
      `${'='.repeat(70)}\n\n`

    let body = ''
    for (let i = 0; i < kept.length; i++) {
      const p = kept[i]
      const date = new Date(p.timestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      body += `--- Pair #${i + 1}  [${date}]  ${p.classifyReason} ${'---'.repeat(10)}\n\n`
      body += `BUYER:\n${p.buyerMessage}\n\n`
      body += `OM REPLY:\n${p.omReply}\n\n`
    }

    const footer = `${'='.repeat(70)}\nEND OF EXPORT — ${kept.length} premium pairs\n`

    return c.json({
      totalMechanical: mechanicalPairs.length,
      totalPremium: kept.length,
      totalSkipped: skipped.length,
      pairs: kept,
      textExport: header + body + footer,
    })
  } catch (err) {
    console.error('[Export] Premium pairs failed:', err)
    return c.json({ error: err.message }, 500)
  }
})

// ===========================================
// Export Cleaned Reply Templates — Claude AI Classification
// ===========================================

const TEMPLATES_CLASSIFY_PROMPT = `You are cleaning saved WhatsApp reply templates for a wholesale blank t-shirt business (BulkPlainTshirt.com / sale91.com). These templates will be stored as AI knowledge.

For each template, classify as KEEP or SKIP:

**SKIP if:**
- Catalog product link only (e.g. "https://sale91.com/catalog/p/oversize-240gsm + 240gsm Oversize 👆") — product catalog already has full details with prices, GSM, colors, sizes
- Duplicate of another template (same content, different shortcut)
- Temporary/time-bound content (e.g. "25 days mein more colors will come", "Launching X in March")
- Too generic with no knowledge value (e.g. "Ask me if any question")
- Internal/operational only (e.g. porter booking, multiple tracking URLs for admin use)

**KEEP if:**
- Contains unique business knowledge (policies, hours, location, payment methods)
- How-to guides (ordering, tracking, account creation, GST)
- Referrals to partners (printer, embroidery, custom orders, bags, machines)
- Product comparisons or explanations (biowash types, fabric info)
- Shipping/delivery info (calculator, Nepal customs)
- Dropshipping, discount policies

For KEEP templates, also assign a category from: business_hours_location, warehouse_location, factory_location, payment_methods, international_payment, pricing_policy, product_comparison, product_info, ordering_guide, account_creation, order_details_guide, tracking_guide, shipping_calculator, size_chart, hd_photos, stock_alerts, gst_guide, printer_coordination, train_shipping_guide, website_ordering, catalog_link, welcome_message, print_referral, embroidery_referral, custom_order_referral, machine_referral, shirts_referral, bags_referral, caps_referral, dropshipping_service, general

Reply as JSON array:
[{"index": 0, "verdict": "KEEP", "category": "payment_methods", "reason": "UPI/bank payment details"}, {"index": 1, "verdict": "SKIP", "reason": "catalog product link, redundant with products.json"}, ...]`

app.get('/api/export/cleaned-templates', async (c) => {
  try {
    const settings = await getSettings()
    const WWBUN_API_URL = settings.wwbunApiUrl || process.env.WWBUN_API_URL
    const DIGITAL_KETU_SECRET = settings.digitalKetuSecret || process.env.DIGITAL_KETU_SECRET

    if (!WWBUN_API_URL || !DIGITAL_KETU_SECRET) {
      return c.json({ error: 'WWBUN_API_URL or DIGITAL_KETU_SECRET not configured' }, 500)
    }

    // Fetch ALL templates (raw, unfiltered) from wwbun
    const response = await fetch(`${WWBUN_API_URL}/api/templates/export?raw=true`, {
      headers: { 'X-Digital-Ketu-Secret': DIGITAL_KETU_SECRET },
    })

    if (!response.ok) {
      return c.json({ error: `wwbun API error: ${response.status}` }, 502)
    }

    const allTemplates = await response.json()
    console.log(`[Export] Fetched ${allTemplates.length} raw templates, sending to Claude for classification...`)

    // Send ALL templates to Claude for classification
    const templatesText = allTemplates.map((t, i) =>
      `[${i}] /${t.shortcut}${t.mediaType ? ` [${t.mediaType}]` : ''}:\n${t.content}`
    ).join('\n\n')

    const classifyResponse = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: TEMPLATES_CLASSIFY_PROMPT,
      messages: [{ role: 'user', content: `Classify these ${allTemplates.length} templates:\n\n${templatesText}` }],
    })

    const classifyText = classifyResponse.content[0].text
    const jsonMatch = classifyText.match(/\[[\s\S]*\]/)
    const classifications = jsonMatch ? JSON.parse(jsonMatch[0]) : []

    const kept = []
    const skippedCount = { total: 0 }
    for (const cls of classifications) {
      const template = allTemplates[cls.index]
      if (!template) continue
      if (cls.verdict === 'KEEP') {
        kept.push({ ...template, category: cls.category || 'general', classifyReason: cls.reason })
      } else {
        skippedCount.total++
      }
    }

    console.log(`[Export] Claude classified: ${kept.length} KEEP, ${skippedCount.total} SKIP`)

    // Build text export grouped by category
    const byCategory = {}
    for (const t of kept) {
      const cat = t.category || 'general'
      if (!byCategory[cat]) byCategory[cat] = []
      byCategory[cat].push(t)
    }

    let text = `CLEANED REPLY TEMPLATES — BulkPlainTshirt.com\n`
    text += `${'='.repeat(70)}\n`
    text += `Exported: ${new Date().toISOString()}\n`
    text += `Total: ${kept.length} templates kept (${allTemplates.length} raw, ${skippedCount.total} skipped by Claude)\n`
    text += `Classified by: Claude Opus (latest)\n`
    text += `${'='.repeat(70)}\n\n`

    for (const [category, items] of Object.entries(byCategory).sort()) {
      text += `--- ${category.toUpperCase().replace(/_/g, ' ')} ${'---'.repeat(15)}\n\n`
      for (const t of items) {
        text += `/${t.shortcut}${t.mediaType ? ` [${t.mediaType}]` : ''} — ${t.classifyReason}:\n`
        text += `${t.content}\n\n`
      }
    }

    text += `${'='.repeat(70)}\nEND — ${kept.length} templates\n`

    return c.json({ totalRaw: allTemplates.length, totalClean: kept.length, totalSkipped: skippedCount.total, templates: kept, textExport: text })
  } catch (err) {
    console.error('[Export] Cleaned templates failed:', err)
    return c.json({ error: err.message }, 500)
  }
})

// ===========================================
// Serve Dashboard (Static Frontend)
// ===========================================

app.use('/*', serveStatic({ root: './dist' }))
app.get('/*', serveStatic({ path: './dist/index.html' }))

// ===========================================
// ===========================================
// PROMPT-CACHE KEEP-ALIVE — kills the cold-cache cost spikes (2026-07-02: 10 spikes in 48h were
// ₹299 of a ₹854 bill — 35% of cost from 4% of replies). The 1h-TTL static-prompt cache expires
// during traffic gaps, so the next buyer's reply pays a full 2x re-write (₹25-33). This pings the
// API with the IDENTICAL static block + a 1-token user message when the cache is 50-58 min old
// (a cache READ ≈ ₹1.5), refreshing the TTL. Chains only continue from real traffic (a ping also
// counts as a touch), and only during IST business hours 07-23 — overnight the cache goes cold on
// purpose (one morning write beats pinging all night). ZERO effect on reply behaviour: no rule,
// model, or flow change — pure cache-economics.
let lastPrewarmIstDay = ''
async function cacheKeepAlive() {
  try {
    const istNow = new Date(Date.now() + 5.5 * 3600 * 1000)
    const istHour = istNow.getUTCHours()
    if (istHour < 7 || istHour >= 23) return  // overnight: let the cache go cold on purpose
    const age = Date.now() - cacheTouch.at
    const warm = cacheTouch.at !== 0 && age <= 58 * 60 * 1000
    const inMaintainWindow = warm && age >= 50 * 60 * 1000
    // MORNING PRE-WARM: the first business-hour tick that finds the cache cold does ONE warm-up
    // write, so the day's first buyers hit a warm cache — the unavoidable overnight cold-write lands
    // HERE (on the keep-alive line) instead of on a real buyer's reply, where on a low-traffic
    // morning it inflates the per-reply cost (6 replies + one ₹25-33 write ⇒ a fake ₹15/reply spike
    // on the chart). Once per IST day; after this the 50-58min maintain cycle holds it warm.
    const istDay = istNow.toISOString().slice(0, 10)
    const needMorningPrewarm = !warm && lastPrewarmIstDay !== istDay
    if (!inMaintainWindow && !needMorningPrewarm) return
    if (needMorningPrewarm) lastPrewarmIstDay = istDay
    const settings = await getSettings()
    let staticPrompt = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT
    const styleGuideChunk = await db.knowledgeChunk.findFirst({
      where: { source: 'STYLE_GUIDE', sourceId: 'om_style_guide' },
      select: { content: true },
    })
    if (styleGuideChunk?.content) staticPrompt += `\n\nOM'S COMMUNICATION STYLE:\n${styleGuideChunk.content}`
    const res = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1,
      system: [{ type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: 'ping' }],
    })
    cacheTouch.at = Date.now()
    const u = res.usage || {}
    // $5/M input: fresh 1x, 1h-cache write 2x, cache read 0.1x — same accounting as the reply path
    const cost = ((u.input_tokens || 0) * 0.000005)
      + ((u.cache_creation_input_tokens || 0) * 0.000005 * 2.0)
      + ((u.cache_read_input_tokens || 0) * 0.000005 * 0.10)
      + ((u.output_tokens || 0) * 0.000025)
    await db.settings.update({ where: { id: 'default' }, data: { dailySpentUsd: { increment: cost } } }).catch(() => {})
    console.log(`[CacheKeepAlive] pinged — read=${u.cache_read_input_tokens || 0} write=${u.cache_creation_input_tokens || 0} cost=$${cost.toFixed(4)}`)
  } catch (err) {
    console.error('[CacheKeepAlive] ping failed (harmless — next buyer pays the write):', err.message)
  }
}
setInterval(cacheKeepAlive, 5 * 60 * 1000)

// COST-CEILING ALARM — Ketu's "interfere only if it goes very high" trigger, automated. Healthy
// full-fidelity Opus cost is ~₹3.3-3.7/reply; sustained above the ceiling means a regression (a
// prompt-size creep, a bug like the 2026-07-09 catalog-in-user-message one, or cache misbehaving),
// never normal clone cost. We watch the trailing-7-day AVERAGE (immune to the low-traffic-morning
// blips) and, when it crosses the ceiling, WhatsApp Ketu directly (max once / 12h) + expose it on
// /api/ai-status for the operator banner. Pure monitoring — ZERO effect on replies.
const COST_ALARM_CEILING_INR = Number(process.env.COST_ALARM_CEILING_INR || 4.5)
const COST_ALARM_USD_TO_INR = 85
let costAlarm = { avgInr: null, replies: 0, over: false, ceiling: COST_ALARM_CEILING_INR, lastAlertAt: 0, checkedAt: null }
async function checkCostCeiling() {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
    const rows = await db.messageLog.findMany({
      where: { status: 'REPLIED', createdAt: { gte: since }, costUsd: { gt: 0.0003 } },
      select: { costUsd: true },
    })
    if (rows.length < 30) {  // too few paid replies to judge — hold
      costAlarm = { ...costAlarm, replies: rows.length, checkedAt: new Date().toISOString() }
      return
    }
    const totalUsd = rows.reduce((s, r) => s + (Number(r.costUsd) || 0), 0)
    const avgInr = (totalUsd / rows.length) * COST_ALARM_USD_TO_INR
    const over = avgInr > COST_ALARM_CEILING_INR
    costAlarm = { ...costAlarm, avgInr: +avgInr.toFixed(2), replies: rows.length, over, checkedAt: new Date().toISOString() }
    if (over && Date.now() - costAlarm.lastAlertAt > 12 * 3600 * 1000) {
      costAlarm.lastAlertAt = Date.now()
      const msg = `⚠️ dk2 cost alert — 7-day average is ₹${avgInr.toFixed(2)}/reply (over the ₹${COST_ALARM_CEILING_INR} ceiling), across ${rows.length} replies. Healthy is ~₹3.3-3.7. This means a regression (prompt-size creep / a bug / cache), not normal clone cost — I'm on it.`
      await notifyOwner(msg).catch(e => console.error('[CostAlarm] owner notify failed:', e.message))
      console.log(`[CostAlarm] TRIPPED — ₹${avgInr.toFixed(2)}/reply over ${rows.length} replies; owner alerted`)
    } else if (over) {
      console.log(`[CostAlarm] over ceiling (₹${avgInr.toFixed(2)}) but within 12h dedupe — no re-alert`)
    }
  } catch (e) {
    console.error('[CostAlarm] check failed:', e.message)
  }
}
setInterval(checkCostCeiling, 60 * 60 * 1000)  // hourly
setTimeout(checkCostCeiling, 90 * 1000)        // once shortly after boot

// Start Server
// ===========================================

const port = parseInt(process.env.PORT || '3000')

export default {
  port,
  fetch: app.fetch,
}

console.log(`[digital-ketu2] Server running on port ${port}`)

// Auto-migrate: add new columns if they don't exist yet
;(async () => {
  try {
    // Add systemPrompt + promptUpdatedAt columns to Settings if missing
    await db.$executeRawUnsafe(`ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "systemPrompt" TEXT`)
    await db.$executeRawUnsafe(`ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "promptUpdatedAt" TIMESTAMP(3)`)
    // Add details JSON column to SyncLog for training history
    await db.$executeRawUnsafe(`ALTER TABLE "SyncLog" ADD COLUMN IF NOT EXISTS "details" JSONB`)
    // Always sync: code (process.js) is the single source of truth for system prompt
    const settings = await db.settings.findUnique({ where: { id: 'default' } })
    if (settings) {
      await db.$executeRawUnsafe(
        `UPDATE "Settings" SET "systemPrompt" = $1, "promptUpdatedAt" = NOW() WHERE id = 'default'`,
        DEFAULT_SYSTEM_PROMPT
      )
    }
    // Fix broken STYLE_PAIR metadata (omReply was stored as "undefined")
    const brokenSample = await db.knowledgeChunk.findFirst({
      where: { source: 'STYLE_PAIR' },
      select: { metadata: true },
    })
    if (brokenSample && (!brokenSample.metadata?.omReply || brokenSample.metadata.omReply === 'undefined')) {
      console.log('[Migration] Deleting broken STYLE_PAIR chunks (omReply was "undefined"). Will re-import on next Sync.')
      const deleted = await db.knowledgeChunk.deleteMany({ where: { source: 'STYLE_PAIR' } })
      console.log(`[Migration] Deleted ${deleted.count} broken STYLE_PAIR chunks`)
    }

    console.log('[Migration] Schema up to date')
  } catch (err) {
    if (!err.message.includes('already exists')) {
      console.error('[Migration] Error:', err.message)
    }
  }
})()

// Run initial sync check on startup
runScheduledSync().catch(err => console.error('[Sync] Startup sync check failed:', err.message))

// Recover welcome-followups dropped by this restart (in-memory timers don't survive a
// redeploy). Delay ~25s so the server + DB are fully up before the sweep runs.
setTimeout(() => {
  recoverPendingFollowups({ db, anthropic }).catch(err => console.error('[FollowupRecovery] startup sweep failed:', err.message))
}, 25000)

// Note: old DeferToKetu cleanup removed — corrections now use KnowledgeChunk (CORRECTION source)
// Threshold is user-configurable from Settings — do NOT reset on startup

export { db, anthropic, getSettings }
