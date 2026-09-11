import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stateDir, config, credentials, acquireLock, getJson, fetchLogs, readJson, writeJson, notifyOwner, syncMemory } from './watch-common.mjs'

export function assessPulse(data, now = Date.now()) {
  const problems = []
  const add = (code, detail) => problems.push({ code, detail })
  if (data.health?.status !== 'ok' || data.health?.db !== 'connected') add('clone-health', 'Clone health or database probe failed')
  for (const endpoint of Object.keys(data.errors || {})) add(`endpoint-${endpoint}`, data.errors[endpoint])
  const logs = data.logs || []
  const failed = logs.filter(row => row.status === 'FAILED')
  if (failed.length) add('failed-replies', `${failed.length} FAILED rows in the checked window`)
  if (logs.some(row => row.deferReason === 'post_model_guard_failed')) add('post-model-guard-failed', 'A reply guard threw; the buyer was deferred and the guard needs investigation')
  if (logs.some(row => /openai_fallback:|all_claude_models_failed/.test(row.deferReason || ''))) add('provider-fallback', 'Primary model failed or backup model used')
  if (logs.some(row => /budget_exceeded|daily_limit|budget_free_reply/.test(row.deferReason || ''))) add('budget-tripped', 'Reply budget blocked a buyer turn')
  let budget = null
  if (data.settings) {
    const usdToInr = Number(data.settings.usdToInr) || 88
    const capInr = Number(data.settings.dailyBudgetInr) || 0
    const replyInr = (Number(data.settings.dailySpentUsd) || 0) * usdToInr
    const jobInr = (Number(data.settings.dailyJobSpentUsd) || 0) * usdToInr
    budget = { replyInr: Math.round(replyInr), jobInr: Math.round(jobInr), spentInr: Math.round(replyInr + jobInr), capInr, usdToInr }
    if (capInr > 0 && replyInr >= capInr && !problems.some(x => x.code === 'budget-tripped')) add('budget-tripped', 'Reply spend reached the daily cap')
    if (data.settings.isActive === false) add('clone-paused', 'Clone is disabled in settings')
  }
  const inbox = data.inbox
  if (inbox && (!inbox.ok || inbox.stuck > 0 || inbox.oldestPendingSec > 900)) add('inbox-stuck', `Inbound journal has ${inbox.stuck || 0} stuck; oldest pending ${inbox.oldestPendingSec || 0}s`)
  const poll = data.poll
  if (poll && !poll.ok) add('comment-health', 'Comment poll health returned not OK')
  if (poll?.ok) {
    if (poll.ig?.pollEnabled !== false && (poll.ig?.ageSec == null || poll.ig.ageSec > 900)) add('instagram-poller', 'Instagram comment poller is stale')
    if ((poll.yt || []).some(row => row.enabled && (row.ageSec == null || row.ageSec > 1800))) add('youtube-poller', 'YouTube comment poller is stale')
  }
  const mature = (data.inbound || []).filter(row => now - Date.parse(row.createdAt) > 180000)
  const loggedIds = new Set(logs.flatMap(row => Array.isArray(row.messageIds) ? row.messageIds : []))
  const missing = mature.filter(row => !loggedIds.has(row.id) && !loggedIds.has(row.whatsappId))
  if (missing.length) add('inbound-without-outcome', `${missing.length} eligible inbound messages older than 3 minutes have no matching log outcome; investigate their source IDs before classifying`)
  return { problems, budget, unmatchedInbound: missing.map(row => ({ id: row.id, createdAt: row.createdAt })), counts: { rows: logs.length, failed: failed.length, sent: logs.filter(row => row.sentViaWwbun).length, inbound: data.inbound?.length || 0, unmatchedMature: missing.length } }
}

export async function pulse({ noAlert = false, noSync = false } = {}) {
  const release = acquireLock('pulse')
  if (!release) return { skipped: 'another pulse is active' }
  try {
    const c = config()
    const { token, secret } = credentials(c)
    const prior = readJson(join(stateDir, 'pulse-state.json'))
    const at = new Date().toISOString()
    const since = new Date(Math.min(Date.now() - 35 * 60000, Date.parse(prior.checkedThrough || at) - 5 * 60000)).toISOString()
    const bridge = { 'X-Digital-Ketu-Secret': secret }
    const calls = {
      health: () => getJson(c.dk2Base + '/api/health'),
      settings: () => getJson(c.dk2Base + '/api/settings', { 'X-DK-Read-Token': token }),
      inbox: () => getJson(c.inboxBase + '/api/dk/inbox-health', bridge),
      poll: () => getJson(c.inboxBase + '/api/comments/poll-health', bridge),
      inbound: () => getJson(c.inboxBase + '/api/dk/recent-inbound?minutes=35', bridge),
      logs: () => fetchLogs(c, token, since, at),
    }
    const data = { errors: {} }
    await Promise.all(Object.entries(calls).map(async ([name, call]) => {
      try { data[name] = await call() } catch (error) { data.errors[name] = error.message }
    }))
    const result = { at, since, build: data.health?.build || null, ...assessPulse(data) }
    const streaks = {}
    for (const problem of result.problems) streaks[problem.code] = (prior.streaks?.[problem.code] || 0) + 1
    const alertAt = { ...prior.alertAt }
    const due = result.problems.filter(problem => {
      const immediate = ['failed-replies', 'post-model-guard-failed', 'inbox-stuck', 'budget-tripped', 'inbound-without-outcome'].includes(problem.code)
      return (immediate || streaks[problem.code] >= 2) && Date.now() - (alertAt[problem.code] || 0) > 3 * 3600000
    })
    if (due.length && !noAlert) {
      notifyOwner(c, 'Ketu clone · health', due.map(row => row.detail).join('\n') + '\nPrivate report: ai-memory/clone-learning/reports/latest-pulse.json')
      for (const problem of due) alertAt[problem.code] = Date.now()
      result.alert = 'workflow dispatched'
    }
    const state = { checkedThrough: Object.keys(data.errors).length ? prior.checkedThrough : at, streaks, alertAt }
    writeJson(join(stateDir, 'pulse-state.json'), state)
    const reports = join(c.memoryRoot, 'clone-learning/reports')
    writeJson(join(reports, 'latest-pulse.json'), result)
    writeJson(join(reports, `pulse-${at.slice(0, 10)}.json`), { ...readJson(join(reports, `pulse-${at.slice(0, 10)}.json`)), [at]: result })
    if (!noSync) result.cloud = syncMemory(c)
    console.log(JSON.stringify(result))
    return result
  } finally { release() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  pulse({ noAlert: process.argv.includes('--no-alert'), noSync: process.argv.includes('--no-sync') }).then(result => { process.exitCode = result.problems?.length ? 1 : 0 }).catch(error => {
    const file = join(stateDir, 'pulse-error.json')
    const previous = readJson(file)
    const result = { at: new Date().toISOString(), error: error.message, alertAt: previous.alertAt || 0 }
    if (!process.argv.includes('--no-alert') && Date.now() - result.alertAt > 3 * 3600000) {
      try { notifyOwner(config(), 'Ketu clone · monitor failed', 'The health monitor could not complete. Check its local pulse-error.json; production has not been declared healthy.'); result.alertAt = Date.now() } catch {}
    }
    writeJson(file, result)
    console.error(error.message)
    process.exitCode = 2
  })
}
