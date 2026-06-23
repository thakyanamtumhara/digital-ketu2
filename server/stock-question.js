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

// Detects replies that must NEVER be learned as a correction because they are tied to ONE order /
// situation: (a) transactional dispatch — Porter/courier tracking links, referral codes, and bare
// "dispatching asap" / "...asap" acks that only describe one in-flight order; (b)
// personal complaint-handling actions ("main complaint daalta hun") that would fire on unrelated
// messages if replayed (this caused the "Complaint daalta on a hello" bug); and (c) point-in-time
// DELIVERY-TIMING answers Ketu gives from live routing knowledge ("2 days by bluedart", "next day
// by train", "kal tak") — city/quantity/mode-specific, so replaying them would fabricate timings
// the clone is explicitly forbidden to guess; and (d) personal FOLLOW-UP PROMISES ("I will inform
// then book", "baaki update karta hun") — commitments Ketu fulfills himself; the auto-bot can't
// message a buyer later, so replaying these would falsely promise a follow-up it never delivers.
export function isTransactionalReply(reply) {
  if (!reply || !reply.trim()) return false
  const t = reply.toLowerCase()
  if (/porter\.in\/|\/rd\/|porter mini|via (porter|dunzo|shiprocket|delhivery)|shiprocket|delhivery|\bdtdc\b|bluedart|ekart|xpressbees|\/tracking|\/track\/|\btracking\b|\bawb\b|\bdispatch(?:ing|ed)?\b|\basap\b|sending you (some )?goods|track (the |your |this )?order|referral code|book.{0,10}porter|order here:|genrate shp|complaint (daal|dal|kar|likh|raise|file)|complain (daal|kar)|shikayat (daal|kar)|\bnext day\b|\bsame day\b|agle din|kal tak|aaj hi (mil|aa|nikal|dispatch|bhej)|\b\d+\s*(-|to|–|\s)?\s*\d*\s*(din|days?|ghant[ae]|hours?|hrs?)\b|\bby (train|air)\b|train se|\b(i will|i'll) (inform|update|let you know|tell you)\b|\bwill (inform|update) you\b|update (karta|kar) (hun|dunga|denge|dunga)|inform (karta|kar) (hun|dunga)|baaki update/.test(t)) return true
  // A reply carrying a buyer's ACCOUNT CREDENTIALS (their login email / a password) is per-buyer
  // private data — replaying it would send one buyer's credentials to another (caught live
  // 2026-06-12: "Email: <buyer>@gmail.com Password: 12345678" auto-captured as a correction).
  if (/password\s*[:=]|[\w.+-]+@(gmail|yahoo|hotmail|outlook|rediffmail|icloud)\./i.test(t)) return true
  // Order-lookup / "send me the bill" asks are point-in-time ORDER HANDLING (only Ketu acts on a
  // bill). Learning them made the clone ask "Bill bhejo / kaun sa order hai" on delivery/tracking
  // complaints instead of deferring (10 such corrections deleted 2026-06-23; caused buyer 9163133430
  // to be looped for a bill on a delivery-delay complaint). Never re-capture these.
  if (/\bbill bhej(o|na|do|iye|dijiye)\b|kaun\s*sa order|konsa order|kaunsa order|which order|share (the )?bill|order (number|no\.?|id) (bhej|batao|do)|tracking link bhej/i.test(t)) return true
  // Month-named restock/launch dates ("September ke baad milega", "October mein aayega") are
  // point-in-time like "7 din mein" — a month + timing particle must never become a correction.
  // (Particle required so plain English "you may order" can't false-positive.)
  if (/\b(jan(uary)?|feb(ruary)?|march|april|may|june|july|aug(ust)?|sept(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\s*(ke\s*(baad|pehle)|mein|me\b|tak|se\b|end|start|last|first)/i.test(t)) return true
  return /(जनवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|सितम्बर|अक्टूबर|नवंबर|दिसंबर)\s*(के\s*(बाद|पहले)|में|तक|से)/.test(t)
}

// The owner talks to the assistant from his OWN WhatsApp (the /api/ask owner channel): instructions
// and answers about his business + software, NOT customer Q&A. These must never be logged to the buyer
// feed or learned as corrections, or they poison the customer clone (e.g. a Porter-webhook deploy reply
// becoming a "correction"). Number is env-overridable; default is the known owner number.
export function isOwnerNumber(num) {
  if (!num) return false
  const owner = (process.env.OWNER_WHATSAPP || '918527150400').replace(/\D/g, '')
  return String(num).replace(/\D/g, '') === owner
}

// A bare media PLACEHOLDER as the buyer message ("[Image]", "[Audio]", "[media]", ...) carries no
// content — it must NEVER be learned as a correction, or it matches EVERY future image/audio message
// at similarity 1.0 and injects a wrong reply (caused "[Image]" -> "Dispatching asap" / "Polo t-shirt").
export function isMediaPlaceholder(text) {
  return /^\s*\[(image|images|photo|audio|voice|video|media|document|sticker|gif|unsupported)\]\s*$/i.test(text || '')
}
