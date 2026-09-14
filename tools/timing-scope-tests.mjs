import assert from 'node:assert/strict'
import { scopedTimingBlock } from '../server/timing-scope.js'

const now = Date.parse('2026-09-14T09:00:00Z')
const fact = (question, answer = '8-9 days') => ({ content: `[stated 2026-09-07] Buyer asked: "${question}" — Ketu's answer: "${answer}"` })
const facts = [fact('Oversize 240gsm Red and Off-white restock?'), fact('Oversize 240gsm Off-white S size restock?', '8-10 days'), fact('Women range launch?', '30 to 45 days max')]
const history = buyerMessage => [{ buyerMessage, createdAt: '2026-09-13T09:00:00Z', status: 'REPLIED' }]
const block = (text, prior = [], rows = facts) => scopedTimingBlock(rows, now, text, prior)
const withheld = text => { assert.match(text, /TIMING SCOPE/); assert.doesNotMatch(text, /Current timing estimate|source stated|1-2 days|1-3 days/) }

withheld(block('Beige me bhi S size nahi he', history('Oversize 240gsm Black White Beige XS S M L XL')))
withheld(block('Off white coming soon mein nahi hai', history('Off white oversized 210 or 240 dono mein S or M nahi hai')))
withheld(block('Oversize 210gsm Red restock?'))
withheld(block('Oversize 240gsm White restock?'))
withheld(block('Oversize 240gsm Red XS kab aayega?'))
withheld(block('Oversize 240gsm Off-white M restock?', [], [facts[1]]))
withheld(block('Oversize 240gsm Off-white restock?', [], [facts[1]]))
withheld(block('Oversize 240gsm Off-white S and M restock?', [], [facts[1]]))
withheld(block('Oversize 240gsm Red restock?', [], [fact('When will it arrive?', 'Oversize 240gsm Red in 8-9 days')]))
withheld(block('Beige nahi hai', [{ ...history('Oversize 240gsm')[0], deferReason: 'manual_reply' }]))
withheld(block('Red restock?', [{ ...history('Oversize 240gsm')[0], createdAt: '2026-09-01T09:00:00Z' }]))
assert.match(block('Oversize 240gsm Red restock?'), /1-2 days/)
assert.match(block('Red restock?', history('Oversize 240gsm colours?')), /1-2 days/)
assert.match(block('Oversize 240gsm Off-white S size restock?'), /1-3 days/)
assert.match(block('Oversize 240gsm Red M size restock?', [], [fact('Oversize 240gsm Red all sizes restock?')]), /1-2 days/)
assert.match(block('When will the women range launch?'), /23-38 days/)
assert.doesNotMatch(block('When will the women range launch?'), /240gsm|1-2 days/)
assert.equal(block('Please send your address'), null)
assert.equal(block('Oversize 240gsm Red price?'), null)
assert.equal(block('Hello sir'), null)
console.log('20 scoped timing cases passed')
