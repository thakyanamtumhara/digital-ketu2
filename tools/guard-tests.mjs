const src = await import('fs').then(m=>m.readFileSync('/Users/ankit/Projects/digital-ketu2/server/process.js','utf8'))
const grab = (name, re) => { const m = src.match(re); if(!m) throw new Error('not found: '+name); return m[0] }
const code = [
  grab('billTextConfirmsOrder', /function billTextConfirmsOrder[\s\S]*?\n}/),
  grab('PAYMENT_HOLD_RE', /const PAYMENT_HOLD_RE = [^\n]*/),
  grab('hasPaymentHoldText', /function hasPaymentHoldText[\s\S]*?\n}/),
  grab('NON_DISPATCH_INTENT_RE', /const NON_DISPATCH_INTENT_RE = [^\n]*/),
].join('\n')
const f = new Function(code + '; return {billTextConfirmsOrder, hasPaymentHoldText, NON_DISPATCH_INTENT_RE}')()

const CASES = [
  // the four real misses — none may reach the canned dispatch ack
  ['MISS 8000770749', 'Sample order kiya tha, koi confirmation nai aya', false],
  ['MISS 9804561285', 'payment kar diya hai, shipment release karwa do', false],
  ['MISS variant',    'maine order kiya tha but abhi tak koi confirmation nahi mila', false],
  ['MISS short-dlv',  '17 Aug ko samaan mangaya tha, mujhe receive hua Navy L 11', false],
  // the common case that MUST keep its instant ack
  ['OK fresh order',  'I have ordered a sample', true],
  ['OK paid',         'order kar diya, payment done', true],
  ['OK hinglish',     'maine order kiya hai abhi', true],
]
let pass=0
for (const [name, txt, wantAck] of CASES) {
  const confirms = f.billTextConfirmsOrder(txt)
  const hold = f.hasPaymentHoldText(txt)
  const nonDispatch = f.NON_DISPATCH_INTENT_RE.test(txt)
  const acked = confirms && !hold && !nonDispatch
  const ok = acked === wantAck
  if(ok) pass++
  console.log(`${ok?'✅':'❌'} ${name.padEnd(18)} ack=${String(acked).padEnd(5)} (want ${wantAck})  [confirms=${confirms} hold=${hold} nonDispatch=${nonDispatch}]`)
  if(!ok) console.log('     text:', txt)
}
console.log(`\n${pass}/${CASES.length} passed`)
