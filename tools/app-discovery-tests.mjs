import assert from 'node:assert/strict'
import { isAppStoreLookupProblem, appDiscoveryReplyGuard } from '../server/app-discovery.js'

const cases = [
  ['App Store mein aapka app nahi mil raha', true],
  ['Play Store pe bhi app nhi mil raha hai', true],
  ["I can't find your app in the App Store", true],
  ['I cannot see it on Play Store', true],
  ['The app is not listed in the App Store', true],
  ['App Store में ऐप नहीं मिल रहा', true],
  ['appstore pe app mil nahi raha', true],
  ['Thanks, found the app in the App Store', false],
  ['I could not find it in the App Store earlier, but installed the app now, thanks', false],
  ['App Store pe mil gaya thanks', false],
  ['I installed the app thanks', false],
  ['Play Store is useful', false],
  ['App Store', false],
  ['Your office app nahi mil raha', false],
  ['Thanks', false],
]
for (const [text, expected] of cases) assert.equal(isAppStoreLookupProblem(text), expected, text)
const buyerText = 'App Store mein aapka app nahi mil raha'
const bad = 'App nahi hai sir — website ko install kar lijiye https://sale91.com'
assert.equal(appDiscoveryReplyGuard({ buyerText, reply: bad }), 'Store par listing nahi hai sir — website ko install kar lijiye https://sale91.com')
assert.equal(appDiscoveryReplyGuard({ buyerText, reply: 'No app sir — install the website https://sale91.com' }), 'There is no store listing sir — install the website https://sale91.com')
for (const reply of ['[DEFER]', `${bad} [DEFER]`, `${bad} [SKIP]`, 'Install the website https://sale91.com', 'App nahi hai sir — install the website https://example.com', 'App nahi hai sir']) {
  assert.equal(appDiscoveryReplyGuard({ buyerText, reply }), reply)
}
assert.equal(appDiscoveryReplyGuard({ buyerText: 'App Store pe mil gaya thanks', reply: bad }), bad)
console.log(`${cases.length + 9} app discovery checks passed`)
