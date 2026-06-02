// Detects buyer questions about live STOCK / AVAILABILITY / RESTOCK-TIMING.
// Any answer to these ("7 days", "abhi nahi", "there is no red", "aa gaya") is true only at
// that moment, so it must NEVER be captured as a permanent correction — the live AI answers
// these dynamically (check website + enable stock alert). Used as a capture-time guard.
export function isStockAvailabilityQuestion(text) {
  if (!text || !text.trim()) return false
  const t = text.toLowerCase()

  // Restock / "when will it come" timing
  if (/kab\s*(aa|aaye|aayeg|aayega|aaega|ayega|milega|tak|aayenge|aa\s*raha)/.test(t)) return true
  if (/\brestock\b|wapas\s*kab|dobara\s*kab|stock\s*kab|kab\s*tak/.test(t)) return true
  if (/when\s+(will|would|are|is)\s+.*(come|back|available|in stock|restock)/.test(t)) return true

  // Explicit stock state
  if (/out\s*of\s*stock|\bin\s*stock\b|stock\s*(hai|me|mein|aaya|aa\s*gaya|aayega|alert|khatam|khatm|khtm|out)|stock\s*alert/.test(t)) return true

  // Stock-out / sold-out / "no longer available" statements
  if (/khatam|khatm|\bkhtm\b|sold\s*out|stock\s*out|available\s*nah|\bleft\s*(hai|kya|kitna|h\b)|kitna.*\bleft\b/.test(t)) return true

  // Size availability ("size M hai kya", "kaun sa size available")
  if (/\bsize\b.*(hai\s*kya|available|left|stock)/.test(t)) return true

  // Colour/size availability ("red hai kya", "red available", "pink ho ga", "240 red kab")
  const colour = /(red|blue|green|black|white|pink|yellow|maroon|marron|grey|gray|navy|beige|orange|purple|brown|olive|mustard|lavender|cream|sky)/
  if (colour.test(t) && /(hai\s*kya|available|ho\s*ga|hoga|milega|aayega|aaega|aayenge|kab|stock|h\s*kya|h\?)/.test(t)) return true

  return false
}

// Detects TRANSACTIONAL / dispatch replies that must NEVER be learned as a correction:
// Porter/courier dispatch notifications, tracking links, referral codes, order-tracking — these
// carry a specific URL/code for ONE order and would leak (stale link, Ketu's referral) if replayed.
export function isTransactionalReply(reply) {
  if (!reply || !reply.trim()) return false
  const t = reply.toLowerCase()
  return /porter\.in\/|\/rd\/|porter mini|via (porter|dunzo|shiprocket|delhivery)|shiprocket|delhivery|\bdtdc\b|bluedart|ekart|xpressbees|\/tracking|\/track\/|\btracking\b|\bawb\b|sending you (some )?goods|track (the |your |this )?order|referral code|book.{0,10}porter|order here:|genrate shp/.test(t)
}
