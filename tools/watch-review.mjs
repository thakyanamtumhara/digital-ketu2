import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stateDir, config, credentials, acquireLock, fetchLogs, readJson, writeJson, notifyOwner, syncMemory, paused } from './watch-common.mjs'

const c = config()
const release = acquireLock('writer')
if (!release) { console.log('Review skipped: another writer holds the lease'); process.exit(0) }
let child
let timedOut = false
function terminateChild() {
  if (!child?.pid) return
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 5000).unref()
}
process.on('SIGTERM', () => { timedOut = true; terminateChild() })
process.on('SIGINT', () => { timedOut = true; terminateChild() })

try {
  if (paused()) { console.log('Review paused: operator owns the current edit session'); process.exitCode = 0 }
  else {
    if (!Array.isArray(c.reviewCommand) || !c.reviewCommand.length) throw new Error('reviewCommand is not configured')
    const at = new Date().toISOString()
    const id = at.replace(/[:.]/g, '-')
    const prior = readJson(join(stateDir, 'review-state.json'))
    const since = new Date(Date.parse(prior.reviewedThrough || new Date(Date.now() - 24 * 3600000).toISOString()) - 5 * 60000).toISOString()
    const { token } = credentials(c)
    const rows = await fetchLogs(c, token, since, at)
    const evidenceDir = join(stateDir, 'evidence')
    const cloudEvidenceDir = join(c.memoryRoot, 'clone-learning/evidence')
    const reportsDir = join(c.memoryRoot, 'clone-learning/reports')
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
    mkdirSync(cloudEvidenceDir, { recursive: true, mode: 0o700 })
    mkdirSync(reportsDir, { recursive: true, mode: 0o700 })
    const evidence = join(evidenceDir, `review-${id}.json`)
    writeJson(evidence, { schemaVersion: 1, since, until: at, rows })
    writeJson(join(cloudEvidenceDir, `review-${id}-manifest.json`), { schemaVersion: 1, since, until: at, rawSource: 'Authenticated production dk2 /api/logs; raw diagnostic copy stays on the operator host', rows: rows.map(row => ({ id: row.id, createdAt: row.createdAt, status: row.status, deferReason: /^[a-z][a-z0-9_:-]{0,100}$/.test(row.deferReason || '') ? row.deferReason : null, sentViaWwbun: row.sentViaWwbun, sha256: createHash('sha256').update(JSON.stringify(row)).digest('hex') })) })
    const workspace = join(stateDir, 'worktrees', id)
    const git = args => {
      const result = spawnSync('git', args, { cwd: c.repository, encoding: 'utf8', timeout: 90000 })
      if (result.status !== 0) throw new Error(`Git ${args[0]} failed; source checkout left untouched`)
      return result.stdout.trim()
    }
    git(['fetch', 'origin', 'main'])
    const base = git(['rev-parse', 'origin/main'])
    git(['worktree', 'add', '-b', `watch/${id}`, workspace, base])
    const report = join(reportsDir, `review-${id}.md`)
    const transcriptDir = join(stateDir, 'transcripts')
    mkdirSync(transcriptDir, { recursive: true, mode: 0o700 })
    const transcript = join(transcriptDir, `review-${id}.jsonl`)
    const instructions = readFileSync(join(c.repository, 'docs/clone-learning/WATCH.md'), 'utf8')
    const prompt = `${instructions}\n\nRUN CONTEXT (trusted operator metadata)\nRun ID: ${id}\nBase commit: ${base}\nIsolated workspace: ${workspace}\nPrivate portable memory: ${c.memoryRoot}\nPrivate evidence: ${evidence}\nCoverage window: ${since} through ${at}\nFinal report path: ${report}\nExisting writer lease belongs to parent PID ${process.pid}; do not acquire it again. Respect ${join(stateDir, 'PAUSE')} before any production mutation.\nReply in the final answer with the full report; the runner also saves that final answer.\n`
    const replacements = { '{workspace}': workspace, '{report}': report }
    const args = c.reviewCommand.map(arg => Object.entries(replacements).reduce((value, [key, replacement]) => value.replaceAll(key, replacement), String(arg)))
    const output = (await import('node:fs')).openSync(transcript, 'w', 0o600)
    try {
      if (timedOut || paused()) throw new Error('Review paused or interrupted during preparation; child not started')
      child = spawn(args[0], args.slice(1), { cwd: workspace, env: process.env, detached: true, stdio: ['pipe', output, output] })
      if (child.pid) release.setChildGroup(child.pid)
      child.stdin.on('error', () => {})
      child.stdin.end(prompt)
      const timer = setTimeout(() => { timedOut = true; terminateChild() }, Math.max(15, Math.min(120, Number(c.reviewTimeoutMinutes) || 90)) * 60000)
      const pauseTimer = setInterval(() => {
        if (paused()) { timedOut = true; terminateChild(); clearInterval(pauseTimer) }
      }, 5000)
      let code
      try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }) }
      finally { clearTimeout(timer); clearInterval(pauseTimer) }
      if (timedOut || code !== 0) throw new Error(`Review interrupted or failed; evidence and worktree retained at ${workspace}`)
      if (!existsSync(report) || readFileSync(report, 'utf8').trim().length < 80) throw new Error('Review produced no complete report; cursor not advanced')
      writeJson(join(stateDir, 'review-state.json'), { reviewedThrough: at, report: `clone-learning/reports/review-${id}.md`, base, workspace })
      writeJson(join(c.memoryRoot, 'clone-learning/reports/latest-review.json'), { completedAt: new Date().toISOString(), reviewedThrough: at, report: `clone-learning/reports/review-${id}.md`, base })
      const cloud = syncMemory(c)
      if (cloud.configured && !cloud.ok) throw new Error('Review finished locally but cloud sync failed')
      console.log(JSON.stringify({ status: 'completed', report, cloud }))
    } finally {
      try { if (child?.pid) process.kill(-child.pid, 'SIGKILL') } catch {}
      (await import('node:fs')).closeSync(output)
    }
  }
} catch (error) {
  writeJson(join(stateDir, 'last-review-error.json'), { at: new Date().toISOString(), error: error.message })
  try { notifyOwner(c, 'Ketu clone · review needs attention', error.message) } catch (notifyError) { console.error(notifyError.message) }
  console.error(error.message)
  process.exitCode = 1
} finally { release() }
