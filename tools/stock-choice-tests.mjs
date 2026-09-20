import assert from 'node:assert/strict'
import { resolvedStockChoice, unavailableStockChoice } from '../server/stock-choice.js'

const now = Date.parse('2026-09-20T08:00:00Z')
const previous = { status: 'REPLIED', buyerMessage: 'Hi Navy small kab update hoga', aiReply: 'Kaun sa product sir — oversize 240, 210 ya acid wash?', createdAt: new Date(now - 60000).toISOString() }
const call = (overrides = {}) => resolvedStockChoice({ buyerText: '210 GSM', history: [previous], now, ...overrides })
const prior = overrides => ({ history: [{ ...previous, ...overrides }] })
const snapshot = { fetchedAt: now, inStock: { 'Oversize 210gsm': { Navy: { S: 200, M: 200 } } }, oos: { 'Oversize 210gsm': { Navy: 'S' } } }
const unavailable = overrides => unavailableStockChoice({ request: 'Oversize 210gsm Navy S stock', snapshot, now, ...overrides })
const tests = [
  ['explicit out-of-stock size is authoritative over price-grid presence', () => assert.equal(unavailable(), true)],
  ['another size cannot inherit an unavailable verdict', () => assert.equal(unavailable({ request: 'Oversize 210gsm Navy M stock' }), false)],
  ['another colour cannot inherit an unavailable verdict', () => assert.equal(unavailable({ request: 'Oversize 210gsm White S stock' }), false)],
  ['unresolved product cannot get a stock verdict', () => assert.equal(unavailable({ request: 'Navy S stock' }), false)],
  ['multiple products cannot get a stock verdict', () => assert.equal(unavailable({ request: 'Oversize 210gsm 240gsm Navy S stock' }), false)],
  ['missing source is not unavailable stock', () => assert.equal(unavailable({ snapshot: null }), false)],
  ['missing fetch time is not fresh stock', () => assert.equal(unavailable({ snapshot: { ...snapshot, fetchedAt: null } }), false)],
  ['stale source is not fresh stock', () => assert.equal(unavailable({ now: now + 300001 }), false)],
  ['future source is not fresh stock', () => assert.equal(unavailable({ now: now - 1 }), false)],
  ['missing offered product cannot receive restock alert', () => assert.equal(unavailable({ snapshot: { ...snapshot, inStock: {} } }), false)],
  ['selected weight restores colour, size and original timing request', () => assert.equal(call(), 'Oversize 210gsm Hi Navy S kab update hoga')],
  ['other offered weight remains a distinct product', () => assert.match(call({ buyerText: '240gsm' }), /^Oversize 240gsm/)],
  ['explicit oversize selection works', () => assert.match(call({ buyerText: 'oversized 210gsm sir' }), /^Oversize 210gsm/)],
  ['English timing preserves meaning', () => assert.equal(call(prior({ buyerMessage: 'When will Navy medium be back?' })), 'Oversize 210gsm When will Navy M be back?')],
  ['stock size letters stay scoped', () => assert.match(call(prior({ buyerMessage: 'Navy XL stock kab aayega' })), /Navy XL/)],
  ['standalone product has no inherited stock task', () => assert.equal(call({ history: [] }), null)],
  ['unoffered product cannot be inherited', () => assert.equal(call({ buyerText: '260gsm' }), null)],
  ['bare weight can be a quantity and stays untouched', () => assert.equal(call({ buyerText: '210' }), null)],
  ['extra buyer task stays untouched', () => assert.equal(call({ buyerText: '210gsm refund bhi chahiye' }), null)],
  ['multiple selections stay unresolved', () => assert.equal(call({ buyerText: '210gsm or 240gsm' }), null)],
  ['new image stays multimodal', () => assert.equal(call({ imageUrl: 'https://media.invalid/x.jpg' }), null)],
  ['previous image is not reduced to text', () => assert.equal(call(prior({ isMedia: true })), null)],
  ['owner answer prevents inheritance', () => assert.equal(call(prior({ deferReason: 'manual_reply' })), null)],
  ['unsent question cannot establish choice', () => assert.equal(call(prior({ status: 'FAILED' })), null)],
  ['stale question cannot establish choice', () => assert.equal(call(prior({ createdAt: new Date(now - 7200001).toISOString() })), null)],
  ['future date cannot establish choice', () => assert.equal(call(prior({ createdAt: new Date(now + 1).toISOString() })), null)],
  ['missing date cannot establish choice', () => assert.equal(call(prior({ createdAt: null })), null)],
  ['unrelated question stays untouched', () => assert.equal(call(prior({ aiReply: 'How many pieces of oversize 210 sir?' })), null)],
  ['selected weight must be offered', () => assert.equal(call(prior({ aiReply: 'Which product sir — oversize 240 or acid wash?' })), null)],
  ['prior named product is not overwritten', () => assert.equal(call(prior({ buyerMessage: '240gsm Navy S stock kab aayega' })), null)],
  ['complaint cannot be inherited as stock', () => assert.equal(call(prior({ buyerMessage: 'Navy S kab hoga refund' })), null)],
  ['unknown script cannot be silently erased', () => assert.equal(call(prior({ buyerMessage: 'Navy S kab update hoga पैसा वापस' })), null)],
  ['multiple colours remain unresolved', () => assert.equal(call(prior({ buyerMessage: 'Navy White S kab update hoga' })), null)],
  ['multiple sizes remain unresolved', () => assert.equal(call(prior({ buyerMessage: 'Navy S M kab update hoga' })), null)],
  ['missing size cannot fabricate one', () => assert.equal(call(prior({ buyerMessage: 'Navy kab update hoga' })), null)],
  ['unknown single-letter words are not sizes', () => assert.equal(call(prior({ buyerMessage: 'stock m kab hoga' })), null)],
  ['ordinary price question cannot become stock', () => assert.equal(call(prior({ buyerMessage: 'Navy S price kya hai' })), null)],
]
let failed = 0
for (const [name, test] of tests) {
  try { test(); console.log(`PASS ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`) }
}
console.log(`${tests.length - failed}/${tests.length} stock choice checks passed`)
process.exitCode = failed ? 1 : 0
