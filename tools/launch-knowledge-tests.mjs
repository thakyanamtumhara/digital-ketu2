import assert from 'node:assert/strict'
import { isSupersededLaunchCorrection as excluded } from '../server/launch-knowledge.js'

const chunk = (question, answer, metadata = { backfilled: true }) => ({ source: 'CORRECTION', content: `Buyer: ${question}\nCorrect reply: ${answer}`, metadata })
assert.equal(excluded(chunk('When is the ladies tee launch?', 'Ladies tees will not launch.')), true)
assert.equal(excluded(chunk('Girls tees launch kab hogi?', 'Girls tshirts nahi aayengi')), true)
assert.equal(excluded(chunk('Womens launch kab hoga?', 'Womens nahi aayega')), true)
assert.equal(excluded(chunk('When is the ladies tee launch?', 'Ladies tees will not launch.', { backfilled: false })), false)
assert.equal(excluded(chunk('When is the ladies tee launch?', 'Not yet sir.')), false)
assert.equal(excluded(chunk('When is the ladies tee launch?', 'In 12 days')), false)
assert.equal(excluded(chunk('When is the girls crop tee launch?', 'Girls tees will not launch.')), false)
assert.equal(excluded(chunk('Girls age 7 launch kab hoga?', 'Girls tshirt nahi aayegi')), false)
assert.equal(excluded(chunk('Unisex girls tees launch?', 'Girls tees will not launch.')), false)
assert.equal(excluded(chunk('When is the kids line launch?', 'It will not launch.')), false)
assert.equal(excluded(chunk('When is the ladies tee launch?', 'Ladies tees will not launch.', '{bad json')), false)
assert.equal(excluded(chunk('When is the ladies tee launch?', 'Ladies tees will not launch.', '{"backfilled":true}')), true)
assert.equal(excluded({ ...chunk('When is the ladies tee launch?', 'Ladies tees will not launch.'), source: 'TIMED_FACT' }), false)
assert.equal(excluded({ source: 'CORRECTION', metadata: { backfilled: true } }), false)
console.log('14 launch knowledge boundaries passed')
