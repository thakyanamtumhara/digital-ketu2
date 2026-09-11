import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { buildAudit } from './audit-interventions-lib.mjs'

const DAYS = Number(process.argv[2] || 3)
if (!Number.isFinite(DAYS) || DAYS <= 0) throw new Error('days must be a positive number')
const BASE = 'https://digital-ketu2-production.up.railway.app'
const TOKEN = readFileSync(join(homedir(), '.dk2_read_token'), 'utf8').trim()
const cutoff = Date.now() - DAYS * 86400000
const fetchSince = new Date(cutoff - 86400000).toISOString()

const pages = []
let truncated = true
for (let i = 0; i < 12; i++) {
  const response = await fetch(`${BASE}/api/logs?limit=200&offset=${i * 200}&lite=1&since=${encodeURIComponent(fetchSince)}`, { headers: { 'X-DK-Read-Token': TOKEN }, signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`logs HTTP ${response.status}; audit incomplete`)
  const page = await response.json()
  if (!Array.isArray(page)) throw new Error('logs returned no row array; audit incomplete')
  pages.push(page)
  if (page.length < 200) { truncated = false; break }
}

const audit = buildAudit(pages.flat(), { since: cutoff })
audit.fetchedAt = new Date().toISOString()
audit.windowSince = new Date(cutoff).toISOString()
audit.truncated = truncated
const out = join(dirname(fileURLToPath(import.meta.url)), 'interventions.json')
writeFileSync(out, JSON.stringify(audit.interventions, null, 1), { mode: 0o600 })
chmodSync(out, 0o600)
const privateDir = process.env.DK2_AUDIT_DIR || join(homedir(), 'dk2_corpus/audits')
mkdirSync(privateDir, { recursive: true, mode: 0o700 })
const privateOut = join(privateDir, `audit-${audit.fetchedAt.replace(/[:.]/g, '-')}.json`)
writeFileSync(privateOut, JSON.stringify(audit, null, 1), { mode: 0o600 })
console.log(`window            : last ${DAYS} day(s), ${audit.stats.rows} rows${truncated ? ' (TRUNCATED at 2400 fetched rows)' : ''}`)
console.log(`paid AI replies   : ${audit.stats.paidReplies} (${audit.stats.repliedRows} including canned replies)`)
console.log(`reply follow-ups  : ${audit.stats.replyFollowupCandidates} unreviewed candidates; ${audit.stats.paidReplyFollowupCandidates} after paid replies`)
console.log(`other follow-ups  : ${audit.stats.otherFollowupCandidates} defer/silence/cooldown/failure candidates`)
console.log(`manual acks       : ${audit.stats.acknowledgmentCount} excluded; ${audit.stats.unpairedManualCount} other manual rows unpaired`)
console.log(`review samples    : ${audit.stats.reviewSamples} without a linked manual follow-up`)
console.log(`wrote ${out}\nprivate audit ${privateOut}`)
console.log('Candidates are not mistakes or a fidelity score. Inspect the full thread and media before grading.')
if (truncated) process.exitCode = 1
