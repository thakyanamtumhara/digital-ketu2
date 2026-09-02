// Regression: the ❄️ WINTER STOCK line is computed from the IST month, never remembered.
// Born 2026-09-02: the fixed "September ke baad" sentence went stale the day the season turned.
import { winterStockLine, WINTER_ITEM_RE } from '../server/process.js'

const CASES = [
  ['Sep  → arriving',   new Date('2026-09-02T10:00:00+05:30'), /start ho gaya/],
  ['Nov  → arriving',   new Date('2026-11-20T10:00:00+05:30'), /start ho gaya/],
  ['Dec  → in season',  new Date('2026-12-05T10:00:00+05:30'), /Coming Soon/],
  ['Feb  → in season',  new Date('2027-02-10T10:00:00+05:30'), /Coming Soon/],
  ['Mar  → off-season', new Date('2027-03-01T10:00:00+05:30'), /September ke baad/],
  ['Aug  → off-season', new Date('2027-08-31T10:00:00+05:30'), /September ke baad/],
  // IST boundary: 31 Aug 23:30 UTC is already 1 Sep in India
  ['UTC 31-Aug 23:30 = IST 1-Sep', new Date('2026-08-31T23:30:00Z'), /start ho gaya/],
]
const TRIGGER = [
  ['hoodie ask',        'Sweatshirt and Hoodies 320 gsm ka Restock kbtk aayega', true],
  ['zipper ask',        'zip hoodie kab aayega', true],
  ['winter word',       'winter ka maal kab tak', true],
  ['plain tee (no)',    'oversize 240 black L kab aayega', false],
  ['zip in a URL (no)', 'https://sale91.com/catalog/p/zip-hoodie', true],
]
let pass = 0, total = 0
for (const [name, d, re] of CASES) {
  total++
  const out = winterStockLine(d)
  const ok = re.test(out)
  if (ok) pass++
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(30)} → ${out.slice(0, 60)}`)
}
for (const [name, txt, want] of TRIGGER) {
  total++
  const got = WINTER_ITEM_RE.test(txt)
  const ok = got === want
  if (ok) pass++
  console.log(`${ok ? '✅' : '❌'} trigger ${name.padEnd(20)} got=${got} want=${want}`)
}
console.log(`\n${pass}/${total} passed`)
process.exit(pass === total ? 0 : 1)
