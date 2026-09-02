import { getStockSnapshot, formatStockBlock } from '/Users/ankit/Projects/digital-ketu2/server/stock-lookup.js'
const s = await getStockSnapshot()
const coming = s.coming || {}
console.log('=== COMING SOON rows (product|colour: ~days) — NOTE: no size dimension ===')
for (const k of Object.keys(coming).sort()) console.log('  ', k, '->', coming[k], 'din')
console.log('\n=== rows matching kids / bio / navy / black ===')
for (const k of Object.keys(coming)) {
  if (/kid|bio|navy|black/i.test(k)) console.log('  MATCH:', k, '->', coming[k])
}
const blk = formatStockBlock(s)
console.log('\n=== what the model saw about Kids ===')
for (const l of blk.split('\n')) if (/kids/i.test(l) && l.length < 400) console.log(' ', l.slice(0,300))
console.log('\n=== what the model saw about Bio ===')
for (const l of blk.split('\n')) if (/bio/i.test(l) && l.length < 400) console.log(' ', l.slice(0,300))
