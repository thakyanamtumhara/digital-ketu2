import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { usdToInrRate } from '../shared/cost.mjs'

for (const rate of [88, 90, 92.5, 0.5]) assert.equal(usdToInrRate({ usdToInr: rate }), rate)
for (const rate of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '90', true, {}]) assert.equal(usdToInrRate({ usdToInr: rate }), 88)
assert.equal(usdToInrRate(), 88)
assert.equal(usdToInrRate(null), 88)

const appPath = fileURLToPath(new URL('../src/App.jsx', import.meta.url))
const source = readFileSync(appPath, 'utf8')
const built = buildSync({
  stdin: { contents: source + '\nexport { DailyBudgetBar, LiveMonitor, Analytics, SettingsPanel, LearningPanel }', resolveDir: dirname(appPath), loader: 'jsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], logLevel: 'silent',
})
const module = { exports: {} }
runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url) })
const components = module.exports
const render = (name, props) => renderToStaticMarkup(React.createElement(components[name], props))
const settings = { usdToInr: 90, dailySpentUsd: 3, dailyBudgetInr: 900, learningDailyBudgetUsd: 4 }
assert.match(render('DailyBudgetBar', { settings }), /Reply budget: Rs\.270 \/ Rs\.900 \(30%\)/)
assert.match(render('DailyBudgetBar', { settings: { ...settings, usdToInr: undefined } }), /Reply budget: Rs\.264/)

const log = { id: 'synthetic-log', createdAt: '2026-09-22T00:00:00Z', status: 'REPLIED', promptTokens: 10, totalTokens: 20, costUsd: 1.25, buyerMessage: 'Synthetic question', aiReply: 'Synthetic answer', sentViaWwbun: true }
const live = render('LiveMonitor', { logs: [log], expandedLog: log.id, exchangeRate: 90 })
assert.ok((live.match(/Rs\.112\.50/g) || []).length >= 2, 'Log header and expanded pipeline must use the same configured rate')

const analytics = { totalMessages: 8, totalReplied: 5, totalDeferred: 2, totalSkipped: 1, loggedCost: { usd: 5, inr: 450, paidRows: 4, scope: 'message_logs_only' }, tokens: { total: 100, totalCostUsd: 1, avgTokensPerReply: 20, avgCostPerReply: 0.5, avgProcessingMs: 100 }, interventionRate: '0%' }
const analyticsHtml = render('Analytics', { analytics, period: 'today', exchangeRate: 90 })
assert.match(analyticsHtml, /Rs\.450\.00<\/div><div[^>]*>Logged AI cost/)
assert.match(analyticsHtml, /Rs\.45\.00<\/div><div[^>]*>Avg paid reply/)
assert.doesNotMatch(analyticsHtml, /Total Cost|Rs\.90\.00/)
assert.match(analyticsHtml, /Excludes jobs, transcription, embeddings and operator costs/)
assert.match(render('Analytics', { analytics: { ...analytics, loggedCost: undefined }, period: 'today', exchangeRate: 90 }), /Unavailable<\/div><div[^>]*>Logged AI cost/)
assert.match(render('Analytics', { analytics: { ...analytics, loggedCost: { inr: 0 } }, period: 'today', exchangeRate: 90 }), /Rs\.0\.00<\/div><div[^>]*>Logged AI cost/)

let changed
const tree = components.SettingsPanel({ settings, updateSetting: (key, value) => { changed = { key, value } } })
const descendants = value => {
  if (Array.isArray(value)) return value.flatMap(descendants)
  if (!value || typeof value !== 'object') return []
  return [value, ...descendants(value.props?.children)]
}
const budgetSetting = descendants(tree).find(item => item.props?.label === 'Learning Budget (INR)')
assert.equal(budgetSetting.props.value, 360)
budgetSetting.props.onChange('540')
assert.deepEqual(changed, { key: 'learningDailyBudgetUsd', value: 6 })
assert.match(render('SettingsPanel', { settings }), /type="number" value="360"/)

const learning = render('LearningPanel', {
  settings, stats: { dailyCost: { spent: 2, budget: 4 }, stats: {}, recentLearnings: [] },
  backlogProgress: { status: 'complete', totalCostUsd: 3 },
  historyPullProgress: { status: 'complete', costUsd: 4 },
})
assert.match(learning, /Rs 180\.0 \/ Rs 360/)
assert.match(learning, /Cost: Rs 270\.0/)
assert.match(learning, /Cost: Rs 360\.0/)
assert.doesNotMatch(source, /(?:\*|\/)\s*85\b/)
assert.match(source, /similarityScore >= 0\.85/)
console.log('Configured-rate, rendered cost scope and learning-budget round-trip checks passed')
