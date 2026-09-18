import assert from 'node:assert/strict'
import { isProspectiveStockWait } from '../server/bill-history.js'

const question = 'Sir mujhe navy color ki hoodie order karni hai lekin size available nahi hai to kab tak rukna padega? Ya pehle se order laga sakte hai?'
const positives = [question, question.replace('navy', 'brown').replace('hoodie', 'polo'), question.split('?')[0], question.replaceAll('hai', 'h').replace('nahi', 'nai').replace('pehle se', 'pehle s'), question.toUpperCase(), question.replaceAll(' ', '\n')]
for (const text of positives) assert.equal(isProspectiveStockWait(text), true, text)
const negatives = ['', null, 'Hoodie kab tak aayegi?', 'Mera hoodie order abhi tak nahi aaya', 'Size available nahi tha, parcel kab tak aayega?', 'Parcel mein delay hai', 'Order kab tak hoga?', 'Payment nahi hua', ...['Parcel abhi tak nahi aaya', 'Refund chahiye', 'Ordered last week', 'Missing item hai'].flatMap(extra => [question + ' ' + extra, extra + ' ' + question]), question.replace('navy color', 'missing parcel'), question.replace('karni', 'kiya'), question.replace('lekin size available nahi hai', 'dispatch nahi hua'), question.replace('navy color', 'navy aur mera order')]
for (const text of negatives) assert.equal(isProspectiveStockWait(text), false, String(text))
console.log(`bill history: ${positives.length + negatives.length} checks passed`)
