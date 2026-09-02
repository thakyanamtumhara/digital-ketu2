const src = (await import('fs')).readFileSync('/Users/ankit/Projects/digital-ketu2/server/process.js','utf8')
const start = src.indexOf('const DISPATCH_VERB =')
const end = src.indexOf('// --- Instagram link spacing floor')
const f = new Function(src.slice(start,end) + '; return scrubDispatchClock')()
const CASES = [
  ['REAL MISS  dispatch hour', 'Aaj 6 baje tak nikal jayega sir 🚚', true],
  ['dispatch by 5',            'Sir aapka maal 5 baje se pehle dispatch ho jayega', true],
  ['english by 6pm',           'It will be dispatched by 6 pm sir', true],
  ['KEEP store hours',         '10 baje se 6 baje tak khula hai sir, Sunday 11-4', false],
  ['KEEP call hours',          'Kal subah 10 baje ke baad call kar lijiye 👉 9336695049', false],
  ['KEEP visit close',         '6 baje band ho jaata hai sir, 10am-6pm ke beech aa jaiye', false],
  ['KEEP plain ack',           'Ok sir, dispatching ASAP 🚚', false],
  ['KEEP day-level',           'Aaj hi dispatch ho jayega sir 🚚', false],
]
let pass=0
for (const [name, txt, shouldChange] of CASES) {
  const out = f(txt)
  const changed = out !== txt
  const ok = changed === shouldChange
  if(ok) pass++
  console.log(`${ok?'✅':'❌'} ${name.padEnd(24)} changed=${changed}`)
  if (changed) console.log('      ->', out)
}
console.log(`\n${pass}/${CASES.length} passed`)
