import assert from 'node:assert/strict'
import { isNearestMetroQuestion } from '../server/metro-question.js'

const cases = [
  ['nearest metro station?', true],
  ['Near metro station', true],
  ['nearby metro', true],
  ['Closest metro station please', true],
  ['Sir, nearest metro station?', true],
  ['Which is the nearest metro station?', true],
  ['What is the closest metro?', true],
  ['Which metro station is nearest?', true],
  ['Which metro is the closest sir?', true],
  ['NEAREST METRO STATION？', true],
  ['  Nearest metro\nstation  ', true],
  ['Saket metro thanks', false],
  ['I am near metro station', false],
  ['My shop is near metro station', false],
  ['Near metro station deliver my parcel', false],
  ['Nearest metro station and refund my order', false],
  ['Metro brand t-shirt', false],
  ['Nearest railway station', false],
  ['metro', false],
  ['[Image]', false],
  ['', false],
  [null, false],
]
for (const [text, expected] of cases) assert.equal(isNearestMetroQuestion(text), expected, String(text))
console.log(`${cases.length} metro question checks passed`)
