import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { formatCloneDigest } from '../server/clone-digest.js'

const zero = formatCloneDigest({ paidReplies: 0, interventions: 0, interventionRatePct: 0, pairs: [], ackCount: 0 })
assert.match(zero, /No paid replies.*No quality score/)
assert.doesNotMatch(zero, /100|fidelity|sab aap jaisa|🎉/i)
const quiet = formatCloneDigest({ paidReplies: 20, interventions: 0, interventionRatePct: 0, pairs: [], ackCount: 2 })
assert.match(quiet, /20.*25 minutes: 0 \(0%\)/)
assert.match(quiet, /not confirmed mistakes/)
assert.match(quiet, /writing style still need review/)
assert.match(quiet, /2 short acknowledgements/)
assert.doesNotMatch(quiet, /100%|fidelity|perfect/i)
const pair = { buyer: 'Where is the catalogue?', ai: 'Please wait', ketu: 'Use the catalogue page' }
const flagged = formatCloneDigest({ paidReplies: 20, interventions: 2, interventionRatePct: 10, pairs: [pair], ackCount: 0 }, { count: 1, items: [pair] })
assert.match(flagged, /25 minutes: 2 \(10%\)/)
assert.match(flagged, /Follow-ups to review/)
assert.match(flagged, /You: Use the catalogue page/)
assert.match(flagged, /review whether the clone could safely answer/)
assert.doesNotMatch(flagged, /confirmed errors|90%|fidelity/i)
const capped = formatCloneDigest({ paidReplies: 20, interventions: 8, interventionRatePct: 40, pairs: Array(8).fill(pair) }, { count: 7, items: Array(7).fill(pair) })
assert.equal((capped.match(/Buyer:/g) || []).length, 11)
assert.equal((capped.match(/…2 more/g) || []).length, 2)
const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
const start = index.indexOf('let lastFidelityDigestDay = null')
const end = index.indexOf('\n}', start) + 2
assert.ok(start >= 0 && end > start)
const sent = []
await runInNewContext(index.slice(start, end) + '\nsendFidelityDigest(true)', {
  formatCloneDigest, console: { log() {}, error(error) { throw Error(error) } },
  computeFidelity: async () => ({ paidReplies: 0, interventions: 0, interventionRatePct: 0, pairs: [] }),
  computeRescuableDefers: async () => ({ count: 0, items: [] }),
  notifyOwner: async message => sent.push(message),
})
assert.equal(sent.length, 1)
assert.match(sent[0], /No quality score is available/)
assert.doesNotMatch(sent[0], /100|fidelity|🎉/i)
console.log('18 honest digest and sender checks passed')
