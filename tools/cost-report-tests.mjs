import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { usdToInrRate } from '../shared/cost.mjs'

const source = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
function route(path, endMarker, dependencies) {
  const start = source.indexOf(`app.get('${path}'`)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start)
  let handler
  runInNewContext(source.slice(start, end), { app: { get(name, callback) { assert.equal(name, path); handler = callback } }, usdToInrRate, ...dependencies })
  return handler
}

for (const rate of [88, 100]) {
  const settings = { usdToInr: rate, dailySpentUsd: 10, dailyBudgetInr: 1500 }
  const countQueries = [], aggregateQueries = []
  const db = { messageLog: {
    count: async query => {
      countQueries.push(query)
      const w = query.where
      if (w.conversation) return 0
      if (w.status === 'REPLIED') return w.costUsd ? 2 : 3
      if (w.status) return 1
      return w.costUsd ? 4 : 5
    },
    aggregate: async query => {
      aggregateQueries.push(query)
      if (query.where.conversation) return { _sum: { costUsd: 0 } }
      if (query.where.status === 'REPLIED') return { _sum: { costUsd: 10, promptTokens: 100, completionTokens: 10, totalTokens: 110 }, _avg: { costUsd: 10 / 3, totalTokens: 110 / 3, processingMs: 20 }, _max: { costUsd: 6 } }
      return { _sum: { costUsd: 15 } }
    },
  } }
  const handler = route('/api/analytics', '// Defer to Ketu list management', { db, getSettings: async () => settings })
  const result = await handler({ req: { query: key => key === 'period' ? 'week' : undefined }, json: value => value })
  assert.equal(result.loggedCost.usd, 15)
  assert.equal(result.loggedCost.inr, 15 * rate)
  assert.equal(result.loggedCost.paidRows, 4)
  assert.equal(result.loggedCost.scope, 'message_logs_only')
  assert.equal(result.tokens.totalCostUsd, 10)
  assert.equal(result.tokens.avgCostPerReply, 5)
  assert.equal(result.dailyBudget.spentInr, 10 * rate)
  assert.equal(result.dailyBudget.percentUsed, ((10 * rate / 1500) * 100).toFixed(1) + '%')
  assert.equal(result.dailyBudget.scope, 'reply_counter_excludes_background_jobs')
  assert.equal(result.usdToInr, rate)
  assert.ok(aggregateQueries.some(query => !query.where.status && !query.where.conversation))
  assert.ok(countQueries.some(query => !query.where.status && query.where.costUsd?.gt === 0 && !query.where.conversation))

  let calls = 0
  const monthly = route('/api/monthly-spend', '// FOLLOW-UP SHORTLIST', {
    getSettings: async () => settings,
    db: { messageLog: { aggregate: async query => { assert.equal(query.where.status, undefined); return { _sum: { costUsd: ++calls }, _count: { _all: calls } } } } },
  })
  const months = await monthly({ json: value => value })
  assert.equal(months.prevMonth.inr, rate)
  assert.equal(months.currentMonth.inr, 2 * rate)
  assert.equal(months.scope, 'message_logs_only')
  assert.equal(months.usdToInr, rate)
}
console.log('36 actual analytics/monthly route checks passed')
