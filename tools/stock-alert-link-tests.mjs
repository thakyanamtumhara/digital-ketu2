import assert from 'node:assert/strict'
import { STOCK_ALERT_URL, stockAlertUrl, canonicalizeStockAlertLinks } from '../server/stock-alert-link.js'

const phone = '9999999999'
const own = STOCK_ALERT_URL + '&ph=' + phone
const cases = [
  ['legacy browser push link', 'Set a stock alert https://sale91.com/?stockalert=1', 'Set a stock alert ' + own],
  ['legacy Notification shortcut without protocol', 'Stock Alert ko enable kar lo - sale91.com/?stockalert=1', 'Stock Alert ko enable kar lo - ' + own],
  ['bare www domain without slash', 'www.sale91.com?stockalert=1', own],
  ['bare current form removes another phone', 'www.bulkplaintshirt.com/delhi-stock.html?ph=8888888888', own],
  ['email-like text is not a stock link', 'user@sale91.com/?stockalert=1', null],
  ['bare lookalike hostname', 'sale91.com.example.com/?stockalert=1', null],
  ['legacy-looking text inside another URL', 'https://example.com/?url=sale91.com/?stockalert=1', null],
  ['bare external URL query is preserved', 'example.com/?url=sale91.com/?stockalert=1', null],
  ['FTP external URL query is preserved', 'ftp://example.com/?url=sale91.com/?stockalert=1', null],
  ['parenthesized external query is preserved', 'example.com/?url=(sale91.com/?stockalert=1)', null],
  ['fragment value is preserved', 'example.com/#sale91.com/?stockalert=1', null],
  ['new line bare shortcut', 'Set stock alerts\nsale91.com/?stockalert=1', 'Set stock alerts\n' + own],
  ['embedded HTTPS in bare external URL', 'example.com/?url=https://sale91.com/?stockalert=1', null],
  ['embedded HTTPS in FTP external URL', 'ftp://example.com/?url=https://sale91.com/?stockalert=1', null],
  ['parenthesized embedded HTTPS', 'example.com/?url=(https://sale91.com/?stockalert=1)', null],
  ['Markdown stock alert', '[Set a stock alert](https://sale91.com/?stockalert=1)', '[Set a stock alert](' + own + ')'],
  ['autolink stock alert', '<https://sale91.com/?stockalert=1>', '<' + own + '>'],
  ['www host without slash', 'https://www.sale91.com?stockalert=1', own],
  ['legacy on bulk site', 'https://bulkplaintshirt.com/?stockalert=1', own],
  ['old phone from a past reply', STOCK_ALERT_URL + '&ph=8888888888', own],
  ['template placeholder', STOCK_ALERT_URL + '&ph={phone}', own],
  ['double template placeholder', STOCK_ALERT_URL + '&ph={{phone}}', own],
  ['truncated shortcut', STOCK_ALERT_URL + '&ph', own],
  ['phone-only form link', 'https://www.bulkplaintshirt.com/delhi-stock.html?ph=8888888888', own],
  ['phone alias form link', 'https://www.bulkplaintshirt.com/delhi-stock.html?phone=8888888888', own],
  ['alert presence opens form even at zero', 'https://www.bulkplaintshirt.com/delhi-stock.html?alert=0&ph=8888888888', own],
  ['plain sheet offered as an alert', 'Stock alert laga lijiye https://www.bulkplaintshirt.com/delhi-stock.html', 'Stock alert laga lijiye ' + own],
  ['English notification offer', 'Set notifications here https://www.bulkplaintshirt.com/delhi-stock.html', 'Set notifications here ' + own],
  ['pure stock sheet', 'Live stock https://www.bulkplaintshirt.com/delhi-stock.html', null],
  ['Coming Soon timing pointer', 'Check Coming Soon https://www.bulkplaintshirt.com/delhi-stock.html', null],
  ['distinct timing and alert links', 'Coming Soon timing: https://www.bulkplaintshirt.com/delhi-stock.html\nSet a stock alert here: ' + STOCK_ALERT_URL, 'Coming Soon timing: https://www.bulkplaintshirt.com/delhi-stock.html\nSet a stock alert here: ' + own],
  ['preceding alert prose does not change later timing clause', 'You can set alerts. For timing, check Coming Soon https://www.bulkplaintshirt.com/delhi-stock.html', null],
  ['product purchase link', 'Order https://sale91.com/catalog/p/acidwash-oversize', null],
  ['order tracking notification', 'Track your order https://sale91.com/?S=1234', null],
  ['other website', 'https://example.com/?stockalert=1', null],
  ['lookalike host', 'https://sale91.com.example.com/?stockalert=1', null],
  ['disabled browser alert', 'https://sale91.com/?stockalert=0', null],
  ['punctuation', '(https://sale91.com/?stockalert=1).', '(' + own + ').'],
  ['mixed owner handoff', 'Set a stock alert https://sale91.com/?stockalert=1\n[DEFER]', 'Set a stock alert ' + own + '\n[DEFER]'],
  ['pure owner handoff', '[DEFER]', null],
  ['HTML query separator', STOCK_ALERT_URL + '&amp;ph=8888888888', own],
]
for (const [name, input, expected] of cases) {
  assert.equal(canonicalizeStockAlertLinks(input, '919999999999'), expected ?? input, name)
}
assert.equal(stockAlertUrl(phone), own)
assert.equal(stockAlertUrl('+91 (99999) 99999'), own)
for (const invalid of ['999999999', 'ig:919999999999', '14155550123', 'buyer-test', '', null]) {
  assert.equal(stockAlertUrl(invalid), STOCK_ALERT_URL, 'no guessed phone: ' + invalid)
  assert.equal(canonicalizeStockAlertLinks(STOCK_ALERT_URL + '&ph=8888888888', invalid), STOCK_ALERT_URL)
  assert.equal(canonicalizeStockAlertLinks('https://www.bulkplaintshirt.com/delhi-stock.html?phone=8888888888', invalid), STOCK_ALERT_URL)
}
const selected = canonicalizeStockAlertLinks(STOCK_ALERT_URL + '&ph=8888888888&type=AcidWash%20Oversize&color=Navy&size=S&pub=1', phone)
const parsed = new URL(selected)
assert.equal(parsed.searchParams.get('ph'), phone)
assert.equal(parsed.searchParams.get('type'), 'AcidWash Oversize')
assert.equal(parsed.searchParams.get('color'), 'Navy')
assert.equal(parsed.searchParams.get('size'), 'S')
assert.equal(parsed.searchParams.has('pub'), false)
assert.equal(canonicalizeStockAlertLinks(selected, phone), selected)
console.log(cases.length + ' stock-alert link cases plus phone, selector and idempotence checks passed')
