// Regression: the restraint gate's FORCE_REPLY_RE — requests that must never be silenced.
const src = (await import('fs')).readFileSync('/Users/ankit/Projects/digital-ketu2/server/process.js', 'utf8')
const m = src.match(/const FORCE_REPLY_RE = (\/[\s\S]*?\/i)\n/)
if (!m) { console.error('FORCE_REPLY_RE not found'); process.exit(2) }
const RE = new Function('return ' + m[1])()
const CASES = [
  ['English pls (2026-09-03 miss)',    'English pls', true],
  ['in English please',                'Please reply in English', true],
  ['hindi me bolo',                    'hindi me bolo', true],
  ['hinglish only',                    'hinglish only', true],
  ['address ask (existing)',           'address bhejo', true],
  ['return ask (existing)',            'I want to return this', true],
  ['plain thanks (must not force)',    'thanks bhai', false],
  ['plain ok (must not force)',        'ok', false],
  ['english word in a sentence (no)',  'I need english fonts printed on tee', false],
]
let pass = 0
for (const [name, txt, want] of CASES) {
  const got = RE.test(txt)
  const ok = got === want
  if (ok) pass++
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(36)} got=${got} want=${want}`)
}
console.log(`\n${pass}/${CASES.length} passed`)
process.exit(pass === CASES.length ? 0 : 1)
