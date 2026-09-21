import assert from 'node:assert/strict'
import { stockColourDenialGuard } from '../server/stock-colour-denial.js'

const now = Date.now()
const snapshot = { fetchedAt: now, inStock: { 'Oversize 210gsm': { Red: { S: 10, M: 10, L: 10 }, Black: { S: 10 } } }, oos: { 'Oversize 210gsm': { Red: 'M', Black: 'S' } } }
const history = [{ status: 'REPLIED', buyerMessage: 'Oversize 210gsm stock?', aiReply: 'Which colour?', createdAt: new Date(now - 60000).toISOString() }]
const base = { buyerText: 'Red restock kab hoga?', reply: 'Black out hai. Red out hai — alert laga lijiye.', snapshot, history, now }
assert.equal(stockColourDenialGuard(base), 'Black out hai. Red S/L available hai — alert laga lijiye.')
assert.equal(stockColourDenialGuard({ ...base, english: true, reply: 'Red is out of stock.' }), 'Red S/L available now.')
assert.equal(stockColourDenialGuard({ ...base, buyerText: '210gsm Red stock?', history: [] }), 'Black out hai. Red S/L available hai — alert laga lijiye.')
assert.equal(stockColourDenialGuard({ ...base, reply: 'Black out hai, Red sold out, check later.' }), 'Black out hai, Red S/L available hai, check later.')

const unchanged = [
  { reply: 'Red S/L available hai.' },
  { reply: 'Red M out hai.' },
  { reply: 'Navy and Red out hai.' },
  { reply: 'Rose Red out hai.' },
  { reply: 'Red out hai kya?' },
  { reply: 'Premium Polo Red out hai.' },
  { reply: '[DEFER]' },
  { reply: 'Red out hai. [DEFER]' },
  { buyerText: 'Black restock?', reply: 'Black out hai.' },
  { buyerText: 'Red M restock?' },
  { buyerText: 'Red price and stock?' },
  { buyerText: 'Red stock? [Image]' },
  { buyerText: 'Polo Red restock?' },
  { buyerText: '210gsm and 240gsm Red restock?' },
  { buyerText: 'Need a refund for Red' },
  { imageUrl: 'https://media.invalid/picture.jpg' },
  { snapshot: { ...snapshot, fetchedAt: now - 300001 } },
  { snapshot: { ...snapshot, fetchedAt: now + 1 } },
  { snapshot: { ...snapshot, oos: null } },
  { snapshot: { ...snapshot, oos: { 'Oversize 210gsm': { Red: 'S,M,L' } } } },
  { snapshot: { ...snapshot, oos: { 'Oversize 210gsm': { Red: ['M'] } } } },
  { history: [] },
  { history: [{ ...history[0], createdAt: new Date(now - 7200001).toISOString() }] },
  { history: [{ ...history[0], buyerMessage: 'Oversize 210gsm Red M stock?' }] },
  { history: [{ ...history[0], deferReason: 'manual_reply' }] },
  { buyerText: '210gsm Red restock?', history: [{ ...history[0], deferReason: 'manual_reply' }] },
  { history: [{ ...history[0], isMedia: true }] },
  { history: [{ ...history[0], status: 'DEFERRED' }] },
  { history: [...history, { ...history[0], buyerMessage: 'Polo stock?', createdAt: new Date(now - 1000).toISOString() }] },
]
for (const change of unchanged) assert.equal(stockColourDenialGuard({ ...base, ...change }), null, JSON.stringify(change))
console.log(`${4 + unchanged.length} whole-colour stock checks passed`)
