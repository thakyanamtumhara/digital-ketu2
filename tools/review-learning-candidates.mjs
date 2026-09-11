import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const STATES = new Set(['pending', 'rejected', 'validated', 'promoted'])
const ORIGINS = new Set(['edit', 'intervention', 'backlog', 'reviewer_manual'])
const REASONS = new Set(['awaiting_validation', 'already_promoted', 'same_topic', 'missing_text', 'missing_media_context', 'missing_timing_subject', 'garbled_transcript', 'holding_line', 'transactional_reply', 'not_stock_timing', 'perishable_stock_answer', 'untrusted_origin', 'different_topic', 'incomplete_validator_response', 'ambiguous_validator_response', 'validator_unavailable', 'stored_in_knowledge'])
const hash = value => createHash('sha256').update(value).digest('hex')
const normal = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const safeId = value => /^[a-zA-Z0-9_-]{1,128}$/.test(String(value || '')) ? value : `hashed_${hash(String(value || ''))}`

export function summarizeLearningCandidates(data, { fetchedAt = new Date().toISOString(), source = '/api/learning/candidates?status=all&limit=200' } = {}) {
  if (!data || !Array.isArray(data.rows) || !Array.isArray(data.counts)) throw new Error('Candidate endpoint returned an invalid shape')
  const counts = { pending: 0, rejected: 0, validated: 0, promoted: 0, unknown: 0 }
  for (const item of data.counts) {
    if (!Number.isSafeInteger(Number(item.count)) || Number(item.count) < 0) throw new Error('Candidate endpoint returned an invalid count')
    counts[STATES.has(item.status) ? item.status : 'unknown'] += Number(item.count)
  }
  const seen = new Set(), entries = [], pairs = new Map()
  for (const row of data.rows) {
    if (!row?.id || seen.has(row.id)) continue
    seen.add(row.id)
    const payload = row.payload || {}
    const pairHash = hash(JSON.stringify([normal(payload.buyerQuestion), normal(payload.correctReply), !!payload.timed]))
    const evidence = {}
    for (const key of ['manualPairId', 'manualLogId', 'sourceLogId']) {
      if (payload.evidence?.[key]) evidence[key] = safeId(payload.evidence[key])
    }
    const entry = {
      candidateId: safeId(row.id),
      status: STATES.has(row.status) ? row.status : 'unknown',
      origin: ORIGINS.has(row.origin) ? row.origin : 'unverified',
      reason: REASONS.has(row.reason) ? row.reason : 'other_reason',
      author: payload.author === 'human_owner' ? 'human_owner' : 'unverified',
      timed: !!payload.timed,
      createdAt: Number.isFinite(Date.parse(row.createdAt)) ? new Date(row.createdAt).toISOString() : null,
      updatedAt: Number.isFinite(Date.parse(row.updatedAt)) ? new Date(row.updatedAt).toISOString() : null,
      payloadSha256: hash(JSON.stringify(payload)), pairSha256: pairHash, evidence,
      contextReview: 'unreviewed; retrieve full thread and original media before promoting',
    }
    entries.push(entry)
    if (!pairs.has(pairHash)) pairs.set(pairHash, [])
    pairs.get(pairHash).push(entry.candidateId)
  }
  const total = Object.values(counts).reduce((a, n) => a + n, 0)
  return {
    schemaVersion: 1, fetchedAt, source, counts, total,
    inspectedRows: entries.length, coverageComplete: entries.length === total,
    actionNeeded: counts.pending + counts.validated + counts.unknown > 0,
    autoPromotion: false,
    evidenceSha256: hash(JSON.stringify(data)),
    repeatedPairs: [...pairs.entries()].filter(([, ids]) => ids.length > 1).map(([pairSha256, candidateIds]) => ({ pairSha256, count: candidateIds.length, candidateIds })),
    repeatDefinition: 'Exact question/reply after Unicode, case and whitespace normalization; not semantic equivalence.',
    entries,
  }
}

export function renderCandidateReport(report) {
  const lines = [
    '# Learning candidates', '',
    `Read-only check: ${report.fetchedAt}. Source: \`${report.source}\`.`, '',
    `Inspected ${report.inspectedRows} of ${report.total} candidates. Coverage ${report.coverageComplete ? 'complete' : 'INCOMPLETE — endpoint result was capped or changed during the read'}.`, '',
    `Pending: ${report.counts.pending}; rejected: ${report.counts.rejected}; validated but unpromoted: ${report.counts.validated}; promoted: ${report.counts.promoted}; unknown: ${report.counts.unknown}.`, '',
    `Repeated normalized pairs: ${report.repeatedPairs.length}. These are possible duplicates, not independently confirmed repeated mistakes.`, '',
    'Original text is intentionally excluded from this portable manifest. Retrieve the candidate from the authenticated production source; compare the payload SHA-256 before reviewing it. Local raw evidence remains outside cloud memory and the public application repository.', '',
    '| Candidate | Status | Reason | Origin | Payload SHA-256 |',
    '|---|---|---|---|---|',
    ...report.entries.map(entry => `| ${entry.candidateId} | ${entry.status} | ${entry.reason} | ${entry.origin} | ${entry.payloadSha256} |`), '',
    '## Review and promotion protocol', '',
    '- Inspect pending, validated and repeated candidates each watch. Rejected evidence remains available; do not discard it merely because a cheap validator disagreed.',
    '- Read the full buyer/owner thread and original media. Confirm actual human provenance, the paired question, and whether the answer is durable policy, a changing fact, or a one-order action.',
    '- Save a redacted lesson, an evidence reference/hash, a regression case and neighboring controls before treating an error class as learned.',
    '- Current API has no candidate approve/promote endpoint or automatic pending retry. This command performs GET only and never approves, rejects, deletes, edits or sends a buyer message.',
    '- Do not work around a pending validator by copying the answer straight into CORRECTION or calling the disabled legacy backfill endpoint. An approved future promotion path must revalidate provenance/context and log the decision; /api/correction still validates any submitted human correction and is not a bypass.',
    '- Keep validated-but-unpromoted rows visible: validation alone does not prove storage or live behavior. Confirm the stored fact, deployed regression and later production output separately.',
    '', `Evidence SHA-256: \`${report.evidenceSha256}\`.`, '',
  ]
  return lines.join('\n')
}

function options(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--input', '--base', '--token-file', '--raw-dir', '--report-dir'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Usage: review-learning-candidates.mjs [--input file] [--base URL] [--token-file file] [--raw-dir dir] [--report-dir dir]')
    result[argv[i].slice(2)] = argv[i + 1]
  }
  return result
}

function isInsideGit(directory) {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true
    if (dirname(current) === current) return false
  }
}

export async function runCandidateReview(argv = process.argv.slice(2)) {
  const opts = options(argv)
  const endpoint = '/api/learning/candidates?status=all&limit=200'
  let data
  if (opts.input) data = JSON.parse(readFileSync(resolve(opts.input), 'utf8'))
  else {
    const token = readFileSync(opts['token-file'] || join(homedir(), '.dk2_read_token'), 'utf8').trim()
    const base = opts.base || 'https://digital-ketu2-production.up.railway.app'
    const url = new URL(endpoint, base)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Candidate API requires an HTTPS origin without URL credentials')
    const response = await fetch(url, { headers: { 'X-DK-Read-Token': token }, signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Candidate inspection HTTP ${response.status}; no clean result recorded`)
    data = await response.json()
  }
  const report = summarizeLearningCandidates(data)
  const id = report.fetchedAt.replace(/[:.]/g, '-')
  const rawDir = resolve(opts['raw-dir'] || join(homedir(), 'dk2_corpus/learning-candidates'))
  const reportDir = resolve(opts['report-dir'] || join(homedir(), 'Projects/ai-memory/clone-learning/audits'))
  if (rawDir === reportDir || rawDir.startsWith(reportDir + '/')) throw new Error('Raw evidence must be separate from portable reports')
  if (isInsideGit(rawDir)) throw new Error('Raw evidence must remain outside every git repository')
  mkdirSync(rawDir, { recursive: true, mode: 0o700 })
  mkdirSync(reportDir, { recursive: true, mode: 0o700 })
  const rawFile = join(rawDir, `candidates-${id}.json`)
  const reportFile = join(reportDir, `learning-candidates-${id}.json`)
  const markdownFile = reportFile.replace(/\.json$/, '.md')
  for (const [file, content] of [[rawFile, JSON.stringify(data)], [reportFile, JSON.stringify(report, null, 2)], [markdownFile, renderCandidateReport(report)]]) {
    writeFileSync(file, content + '\n', { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  console.log(JSON.stringify({ status: report.coverageComplete ? 'review_required_or_empty' : 'incomplete', counts: report.counts, inspectedRows: report.inspectedRows, total: report.total, repeatedPairs: report.repeatedPairs.length, autoPromotion: false, report: reportFile, markdown: markdownFile, rawLocalEvidence: rawFile }))
  if (!report.coverageComplete) process.exitCode = 1
  return report
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCandidateReview().catch(error => { console.error(error.message); process.exitCode = 1 })
}
