import assert from 'node:assert/strict'
import { getBuyerProfile, lookupOrdersByPhone, formatBuyerProfileBlock, formatOrderLookupBlock } from '../server/order-lookup.js'

let checks = 0
const check = async (name, run) => { await run(); checks++; console.log('PASS ' + name) }
const unknown = text => {
  assert.match(text, /status UNKNOWN/)
  assert.doesNotMatch(text, /NOT yet (?:courier-)?booked|no AWB yet/)
}
const profile = { count: 1, lastDate: '2026-09-26', lastDays: 0, lastAwb: null }

await check('recent profile with no AWB states uncertainty, including non-courier modes', () => {
  const text = formatBuyerProfileBlock(profile)
  unknown(text)
  assert.match(text, /Porter\/bike\/transport/)
  assert.match(text, /do not infer that a booking or tracking link does not exist/)
})
await check('verified profile tracking remains available', () => {
  const text = formatBuyerProfileBlock({ ...profile, lastAwb: 'a1234567890', lastTrackUrl: 'https://trq.pages.dev/?a1234567890' })
  assert.match(text, /newest order BOOKED, tracking: https:\/\/trq.pages.dev\/\?a1234567890/)
  assert.doesNotMatch(text, /UNKNOWN/)
})
await check('old and undated profiles do not imply a recent booking state', () => {
  for (const lastDays of [4, 90, null]) assert.doesNotMatch(formatBuyerProfileBlock({ ...profile, lastDays }), /AWB|BOOKED|UNKNOWN/)
})
await check('absent profile and no-order boundaries remain unchanged', () => {
  assert.equal(formatBuyerProfileBlock(null), null)
  assert.match(formatBuyerProfileBlock({ count: 0 }), /different number/)
  assert.equal(formatOrderLookupBlock(null), null)
  assert.match(formatOrderLookupBlock([]), /NO orders found.*\[DEFER\]/)
})
await check('lookup without verified AWB preserves owner handoff without invented status', () => {
  const text = formatOrderLookupBlock([{ shortId: 'TEST-42', date: '2026-09-26', awb: null }])
  unknown(text)
  assert.match(text, /no verified tracking record[^]*\[DEFER\]/)
  assert.match(text, /does NOT prove that a booking or tracking link does not exist/)
})
await check('mixed lookup preserves verified tracking on the correct order', () => {
  const text = formatOrderLookupBlock([
    { shortId: 'TEST-42', awb: null },
    { shortId: 'TEST-41', awb: 'a1234567890', courier: 'Courier', trackUrl: 'https://trq.pages.dev/?a1234567890' },
  ])
  assert.match(text, /Order TEST-42[^\n]*UNKNOWN/)
  assert.match(text, /Order TEST-41[^\n]*booked, AWB a1234567890[^\n]*https:\/\/trq.pages.dev\/\?a1234567890/)
})

const originalFetch = globalThis.fetch
try {
  for (const [label, logs] of [['empty', []], ['booking error', [{ error_booking: 'booking service unavailable' }]], ['query failure', null]]) {
    await check(label + ' cannot assert an unbooked order in either runtime source', async () => {
      globalThis.fetch = async (_url, options) => {
        const { sql } = JSON.parse(options.body)
        if (/FROM orders/.test(sql)) return { ok: true, json: async () => ({ rows: [{ odid: 'BillNo_TEST-42', dt: Date.now(), od: {}, tv: 100 }] }) }
        if (logs === null) throw Error('simulated booking lookup outage')
        return { ok: true, json: async () => ({ rows: logs }) }
      }
      const number = '90000000' + String(checks).padStart(2, '0')
      unknown(formatBuyerProfileBlock(await getBuyerProfile(number)))
      unknown(formatOrderLookupBlock(await lookupOrdersByPhone(number)))
    })
  }
  await check('verified booking record survives lookup and formatting', async () => {
    globalThis.fetch = async (_url, options) => ({ ok: true, json: async () => ({ rows: /FROM orders/.test(JSON.parse(options.body).sql)
      ? [{ odid: 'BillNo_TEST-41', dt: Date.now() }]
      : [{ error_booking: 'a1234567890' }] }) })
    assert.match(formatOrderLookupBlock(await lookupOrdersByPhone('9000000099')), /booked, AWB a1234567890/)
  })
} finally { globalThis.fetch = originalFetch }
console.log(`${checks} order-lookup checks passed`)
