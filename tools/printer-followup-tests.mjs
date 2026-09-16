import assert from 'node:assert/strict'
import { isPrinterFulfilmentFollowup } from '../server/printer-followup.js'

const now = Date.parse('2026-01-01T12:00:00Z')
const recent = [{ aiReply: 'For printing, contact the printer https://wa.me/910000000000', createdAt: new Date(now - 60000) }]
const cases = [
  ['pronoun shipping question', 'Can he print them and ship directly to us', recent, true],
  ['short print/send question', 'Does he print and courier to us', recent, true],
  ['named printer question', 'Could the printer print these & courier them to me?', recent, true],
  ['plural pronoun', 'Can they print those and send them to us sir', recent, true],
  ['acknowledgement', 'Okay I will talk to him', recent, false],
  ['statement', 'He will print and send directly to me', recent, false],
  ['unrelated person', 'Will he send money to me', recent, false],
  ['past order', 'He printed them but did not send them to me', recent, false],
  ['mixed task', 'Can he print and ship to me and check my payment', recent, false],
  ['no referral', 'Can he print and ship to me', [], false],
  ['different newest answer', 'Can he print and ship to me', [{ ...recent[0], aiReply: 'Please speak with the courier.' }, ...recent], false],
  ['no contact link', 'Can he print and ship to me', [{ ...recent[0], aiReply: 'The printer is independent.' }], false],
  ['holding answer', 'Can he print and ship to me', [{ ...recent[0], aiReply: recent[0].aiReply + ' [DEFER]' }], false],
  ['stale referral', 'Can he print and ship to me', [{ ...recent[0], createdAt: new Date(now - 7200001) }], false],
  ['future referral', 'Can he print and ship to me', [{ ...recent[0], createdAt: new Date(now + 1000) }], false],
  ['missing timestamp', 'Can he print and ship to me', [{ aiReply: recent[0].aiReply }], false],
]
for (const [name, text, history, expected] of cases) assert.equal(isPrinterFulfilmentFollowup(text, history, now), expected, name)
console.log(`${cases.length} printer follow-up checks passed`)
