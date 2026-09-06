// Regression: clock line (2026-09-06) — godam open/closed, calling hours, holidays. Pure.
import { istTimeBlock } from '../server/process.js'
const at = iso => Date.parse(iso)
let pass = 0, total = 0
const t = (name, got, want) => { total++; const ok = got === want; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name.padEnd(58)} got=${got} want=${want}`) }
const sunEve = istTimeBlock(at('2026-09-06T18:45:00+05:30'))
t('MISS 18:45 Sunday: godam CLOSED', /GODAM RIGHT NOW: CLOSED/.test(sunEve), true)
t('Sunday hours named', /11am–4pm \(Sunday\)/.test(sunEve), true)
t('closed → no same-day dispatch instruction', /NO same-day dispatch/.test(sunEve), true)
t('Sunday noon: OPEN', /GODAM RIGHT NOW: OPEN/.test(istTimeBlock(at('2026-09-06T12:00:00+05:30'))), true)
t('Monday 17:30: OPEN', /GODAM RIGHT NOW: OPEN/.test(istTimeBlock(at('2026-09-07T17:30:00+05:30'))), true)
t('Monday 18:30: CLOSED', /GODAM RIGHT NOW: CLOSED/.test(istTimeBlock(at('2026-09-07T18:30:00+05:30'))), true)
t('Tuesday 09:00: CLOSED + outside calling hours', /CLOSED/.test(istTimeBlock(at('2026-09-08T09:00:00+05:30'))) && /OUTSIDE CALLING HOURS/.test(istTimeBlock(at('2026-09-08T09:00:00+05:30'))), true)
t('Tuesday 15:00: within calling hours', /within calling hours/.test(istTimeBlock(at('2026-09-08T15:00:00+05:30'))), true)
t('day + date correct', /TODAY \(IST\): Sunday, 2026-09-06\. TOMORROW \(IST\): Monday/.test(sunEve), true)
t('Independence Day flagged', /PUBLIC HOLIDAY: TODAY is Independence Day/.test(istTimeBlock(at('2026-08-15T12:00:00+05:30'))), true)
t('default now runs', typeof istTimeBlock() === 'string', true)
console.log(`\n${pass}/${total} passed`); process.exit(pass === total ? 0 : 1)
