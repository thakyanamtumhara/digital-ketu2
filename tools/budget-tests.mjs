import assert from 'node:assert/strict'
import { replySpendInr } from '../server/process.js'

assert.equal(replySpendInr({ dailySpentUsd: 10, usdToInr: 88 }), 880)
assert.equal(replySpendInr({ dailySpentUsd: 10, usdToInr: 90 }), 900)
assert.equal(replySpendInr({ dailySpentUsd: 10, dailyJobSpentUsd: 50, usdToInr: 88 }), 880)
assert.equal(replySpendInr({ dailySpentUsd: 10 }), 880)
assert.equal(replySpendInr({ dailySpentUsd: 0, usdToInr: 88 }), 0)
console.log('5 budget conversion checks passed')
