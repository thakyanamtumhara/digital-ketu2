import { readFileSync } from 'fs'
import { getStockSnapshot, formatStockBlock } from '/Users/ankit/Projects/digital-ketu2/server/stock-lookup.js'

const KEY = process.env.ANTHROPIC_API_KEY
const SYS = readFileSync('/private/tmp/claude-501/-Users-ankit-Projects/7f118894-3f3b-4874-a452-db1404448678/scratchpad/live_prompt.txt','utf8')
const BLOCK = formatStockBlock(await getStockSnapshot())

const CASES = [
  { id:'1 REAL MISS  Kids Black 24 + TrueBio Navy 38', msg:'Kids black 24 and true bio Navy 38 when will be restocked?', mustNotDate:true },
  { id:'2 REAL MISS  follow-up push',                  msg:'Oh 6 days is too long. Kids Black 24 at least will be in stock sooner?', mustNotDate:true },
  { id:'3 CONTROL+   Kids Mustard 32 (IS coming ~5d)', msg:'Kids mustard yellow 32 kab tak aayega?', mustDate:true },
  { id:'4 GUARD      TrueBio Navy 38 alone',           msg:'true bio navy 38 kab milega sir?', mustNotDate:true },
  { id:'5 CONTROL+   240 Oversize Black L (coming 1d)',msg:'240 oversize black L kab aayega?', mustDate:true },
  { id:'6 GUARD      Kids Black 24 direct',            msg:'kids black 24 kab tak aa jayega?', mustNotDate:true },
]

const DATE_RE = /\d+\s*(-|to|se)?\s*\d*\s*(din|days?|day|hafta|week|ghante)|aa\s*jayega\s*(kal|parso)|next\s*week|arriving any day|any day/i
let cost = 0
for (const c of CASES) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'x-api-key':KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
    body: JSON.stringify({ model:'claude-opus-5', max_tokens:400,
      system:[{type:'text',text:SYS,cache_control:{type:'ephemeral'}}],
      messages:[{role:'user',content:BLOCK+'\n\nBuyer message: '+c.msg}] })
  })
  const j = await r.json()
  if (j.error) { console.log(c.id,'API ERROR', j.error.message); continue }
  const txt = (j.content||[]).map(b=>b.text||'').join(' ').trim()
  const u = j.usage||{}
  cost += ((u.input_tokens||0)*15 + (u.cache_read_input_tokens||0)*1.5 + (u.cache_creation_input_tokens||0)*18.75 + (u.output_tokens||0)*75)/1e6
  const hasDate = DATE_RE.test(txt)
  const ok = c.mustNotDate ? !hasDate : hasDate
  console.log(`\n${ok?'✅':'❌'} ${c.id}`)
  console.log('   buyer:', c.msg)
  console.log('   reply:', txt.replace(/\n/g,' ').slice(0,230))
  if (!ok) console.log('   >>> EXPECTED', c.mustNotDate?'NO date':'a date', '| date found:', hasDate)
}
console.log(`\n--- replay cost: $${cost.toFixed(3)} ≈ ₹${(cost*89).toFixed(0)} ---`)
