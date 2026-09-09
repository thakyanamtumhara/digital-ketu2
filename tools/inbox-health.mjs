// wwbun WebhookInbox health — "no buyer message may go missing" (Ketu, 2026-09-09).
// Reads the s2s secret from ~/Projects/wwbun/owner-runner/.env (never printed) and shows whether
// any inbound webhook (WhatsApp / Instagram DM / MSG91 bridge) is pending, stuck or was replayed.
// Run each watch tick: `node tools/inbox-health.mjs`. Exit 1 when something is stuck.
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const env = readFileSync(join(homedir(), 'Projects/wwbun/owner-runner/.env'), 'utf8')
const secret = (env.match(/DIGITAL_KETU_SECRET="?([^"\n]+)/) || [])[1]
if (!secret) { console.error('no DIGITAL_KETU_SECRET in owner-runner/.env'); process.exit(2) }
const res = await fetch('https://mm.sale91.com/api/dk/inbox-health', { headers: { 'X-Digital-Ketu-Secret': secret }, signal: AbortSignal.timeout(30000) })
const d = await res.json().catch(() => ({}))
if (!res.ok || !d.ok) { console.error('inbox-health error', res.status, JSON.stringify(d).slice(0, 300)); process.exit(2) }
const ist = (s) => s ? new Date(s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '-'
console.log(`wwbun inbox: received 1h=${d.receivedLastHour} processed 1h=${d.processedLastHour} | 24h received=${d.receivedLastDay} replayed=${d.replayedLastDay} | pending=${d.pending} stuck=${d.stuck} oldestPending=${d.oldestPendingSec ?? 0}s`)
for (const f of d.failures || []) console.log(`  ${f.source.padEnd(9)} ${ist(f.receivedAt)}  attempts=${f.attempts}  ${String(f.lastError || '').slice(0, 100)}`)
// Comment pollers (YouTube + Instagram) — 2026-09-09: two IG comments were lost to a failed poll.
let pollBad = false
try {
  const pr = await fetch('https://mm.sale91.com/api/comments/poll-health', { headers: { 'X-Digital-Ketu-Secret': secret }, signal: AbortSignal.timeout(30000) })
  const p = await pr.json().catch(() => ({}))
  if (p.ok) {
    const ig = p.ig || {}
    const igAge = ig.ageSec == null ? 'never' : `${Math.round(ig.ageSec / 60)}m ago`
    console.log(`comment pollers: IG last cycle ${igAge} (${ig.source}, ${ig.mediaTracked} posts tracked, ${ig.failedMedia || 0} failed, ${ig.lastIngested || 0} new)${ig.lastError ? ` lastError=${String(ig.lastError).slice(0, 80)} @${ist(ig.lastErrorAt)}` : ''} | YT ${(p.yt || []).map(y => `${y.kind}:${y.ageSec == null ? 'never' : Math.round(y.ageSec / 60) + 'm'}`).join(' ')} | quota ${p.quotaUsed}`)
    if (ig.pollEnabled !== false && (ig.ageSec == null || ig.ageSec > 15 * 60)) pollBad = true
    if ((p.yt || []).some(y => y.enabled && (y.ageSec == null || y.ageSec > 30 * 60))) pollBad = true
    if (pollBad) console.log('  ⚠️ a comment poller has not completed a cycle recently')
  } else console.log('poll-health error', pr.status, JSON.stringify(p).slice(0, 200))
} catch (e) { console.log('poll-health unreachable:', e.message); pollBad = true }
process.exit(d.stuck > 0 || (d.oldestPendingSec || 0) > 900 || pollBad ? 1 : 0)
