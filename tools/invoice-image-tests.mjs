import assert from 'node:assert/strict'
import { invoiceImageKind } from '../server/invoice-image.js'

const now = new Date('2026-09-22T06:00:00Z')
let checks = 0
function check(answer, expected, at = now) {
  assert.equal(invoiceImageKind(answer, at), expected, String(answer))
  checks++
}
for (const kind of ['TRACKING', 'PAYMENT', 'STALE']) check(` ${kind.toLowerCase()}\n`, kind)
for (const kind of ['TRACKING', 'PAYMENT', 'STALE']) {
  check(`${kind}\n\nThe document has the corresponding evidence.`, kind)
  check(`${kind}\r\nExplanation truncated`, kind)
  check(`${kind} or NO`, false)
  check(`Probably ${kind}`, false)
}
check('FRESH|UNKNOWN\nExplanation', false)
check('FRESH|2026-09-22\nExplanation', false)
check('FRESH|UNKNOWN', 'FRESH')
check(' fresh|2026-09-22 \n', 'FRESH')
check('FRESH|2026-09-21', 'FRESH')
check('FRESH|2026-08-24', 'FRESH')
check('FRESH|2026-08-23', 'OLD')
check('FRESH|2026-07-15', 'OLD')
check('FRESH|2024-02-29', 'OLD')
for (const answer of [null, '', 'NO', 'YES', 'FRESH', 'FRESH or TRACKING', 'PAYMENT or FRESH', 'FRESH\nTracking number shown', 'STALE?', 'FRESH|2026-02-29', 'FRESH|2026-04-31', 'FRESH|2026-13-01', 'FRESH|22-09-2026', 'FRESH|2026-09-22|2026-09-21', 'FRESH|2026-09-23', 'FRESH|UNKNOWN extra', 'STALE|2026-07-15']) check(answer, false)
check('FRESH|2026-08-23', 'FRESH', new Date('2026-09-21T18:29:59Z'))
check('FRESH|2026-08-23', 'OLD', new Date('2026-09-21T18:30:00Z'))
check('FRESH|2026-09-22', false, NaN)
console.log(`Invoice image verdicts: ${checks} checks passed`)
