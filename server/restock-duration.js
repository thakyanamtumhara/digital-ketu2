const normalize = value => String(value || '').toLowerCase().replace(/[?.,!]+/g, ' ').replace(/\s+/g, ' ').trim()
const COLOUR = '(?:off[ -]?white|black|white|navy|maroon|beige|grey|gray|red|brown|lavender)'
const SELECTION = new RegExp(`^(${COLOUR})\\s*(hoodie|hoodi)(?:\\s+need\\s+\\d{1,3}\\s+pcs(?:\\s+i have an order)?)?$`)
const STOCK_START = new RegExp(`^(?:(?:hi|hello|sir|please)\\s+)*(${COLOUR})(?:\\s+hoodi(?:e)?)?\\s+(?:kab tak stock (?:aaye?ga|aye ga)|when will (?:the )?stock (?:arrive|come)|restock kab tak)(?:\\s+sir)?$`)
const DURATION = /^(?:(?:please|pls|sir)\s+)?(?:tell me (?:the )?duration|how long|how much time|kitna time|kitne din)(?:\s+(?:sir|bhai))?$/
const sameColour = value => value.replace(/[ -]/g, '').replace('gray', 'grey')

export function restockDurationContext({ buyerText, history = [], imageUrl, quotedText, now = Date.now() }) {
  if (imageUrl || quotedText || !DURATION.test(normalize(buyerText)) || !Array.isArray(history)) return null
  const recent = history.slice(-3)
  const latest = recent.at(-1)
  const selected = SELECTION.exec(normalize(latest?.buyerMessage))
  if (!selected) return null
  const colour = sameColour(selected[1])
  let lastTime = now
  for (let i = recent.length - 1; i >= 0; i--) {
    const row = recent[i]
    const at = Date.parse(row.createdAt)
    if (!Number.isFinite(at) || at > lastTime || now - at > 30 * 60000) return null
    lastTime = at
    if (row.status !== 'REPLIED' || row.deferReason === 'manual_reply' || row.isMedia || /\[defer\]|ketu will reply/i.test(row.aiReply || '')) return null
    const text = normalize(row.buyerMessage)
    const start = STOCK_START.exec(text)
    if (start) return sameColour(start[1]) === colour ? `${selected[1]} hoodie restock timing` : null
    const selection = SELECTION.exec(text)
    if (!selection || sameColour(selection[1]) !== colour) return null
  }
  return null
}

export function restockDurationHint(request) {
  return request ? `RESTOCK DURATION CONTEXT: This short follow-up continues the buyer's recent ${request} question. Answer restock timing from current exact stock/ETA data, or ask which GSM and size is needed. Courier transit and dispatch estimates do not answer this question. Never infer a restock date from a delivery estimate.\n\n` : ''
}

export function restockDurationGuard({ request, reply }) {
  if (!request || !reply) return null
  const courier = /\b(?:dispatch(?:ing|ed)?\s+(?:today|tomorrow|in|within)|will\s+(?:be\s+)?dispatch|delivery date)\b|\b(?:courier|shipping|transit|deliver(?:y|ed)?|reaches|mil jaata|mil jata)\b.{0,40}\d+\s*(?:[-–]\s*\d+\s*)?(?:days?|din|hours?|ghante)\b/i
  return courier.test(reply) ? '[DEFER]' : null
}
