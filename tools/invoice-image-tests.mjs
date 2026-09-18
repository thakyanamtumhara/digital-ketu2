import assert from 'node:assert/strict'
import { invoiceImageKind } from '../server/invoice-image.js'

for (const kind of ['TRACKING', 'PAYMENT', 'FRESH', 'STALE']) {
  assert.equal(invoiceImageKind(` ${kind.toLowerCase()}\n`), kind)
}
for (const answer of [null, '', 'NO', 'YES', 'FRESH or TRACKING', 'PAYMENT or FRESH', 'FRESH\nTracking number shown', 'STALE?']) {
  assert.equal(invoiceImageKind(answer), false, `Ambiguous verdict must not authorize dispatch: ${answer}`)
}
console.log('Invoice image verdicts: 12 checks passed')
