import assert from 'node:assert/strict'
import { isGameEarningsFollowup } from '../server/game-followup.js'

const now = Date.parse('2026-01-01T12:00:00Z')
const recent = [{ buyerMessage: 'What is the website game for?', aiReply: 'Just for play purpose sir.', createdAt: new Date(now - 60000) }]
const cases = [
  ['earning clarification', 'Could I make money from this game?', recent, true],
  ['short pronoun', 'Can I earn from it', recent, true],
  ['play verb', 'Can we earn cash by playing that game', recent, true],
  ['acknowledgement', 'Okay sir', recent, false],
  ['income statement', 'We can earn money from it', recent, false],
  ['referral topic', 'Can I earn money through referrals', recent, false],
  ['mixed payment task', 'Can I earn money from it and refund my order', recent, false],
  ['no context', 'Can I earn from it', [], false],
  ['unanswered game', 'Can I earn from it', [{ ...recent[0], aiReply: 'Ketu will reply shortly sir.' }], false],
  ['unrelated current answer', 'Can I earn from it', [{ ...recent[0], buyerMessage: 'Is my parcel booked?', aiReply: 'Here is your tracking.' }, ...recent], false],
  ['stale game', 'Can I earn from it', [{ ...recent[0], createdAt: new Date(now - 7200001) }], false],
  ['missing timestamp', 'Can I earn from it', [{ ...recent[0], createdAt: null }], false],
  ['future timestamp', 'Can I earn from it', [{ ...recent[0], createdAt: new Date(now + 1000) }], false],
]
for (const [name, text, history, expected] of cases) assert.equal(isGameEarningsFollowup(text, history, now), expected, name)
console.log(`${cases.length} game follow-up checks passed`)
