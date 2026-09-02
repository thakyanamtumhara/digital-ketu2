// PHOTO & VIDEO DEEP LINKS (2026-08-16, Ketu's ask: "somebody is asking for a 240 GSM royal blue
// photo — can we simply send him that photo link? He clicks it, sees that photo, and notices there
// are other photos also, so he will swipe").
//
// The website ALREADY supports this; nothing had to be built there. new.js reads two query params:
//   ?photos=<product>            → opens the gallery on that product's tab
//   ?media=/ph/<folder>/<n>.webp → opens the gallery AND scrolls to that exact photo
//   ?media=/ph/vid/<file>.mp4    → same for a video, and auto-plays it
// Verified live in a browser 2026-08-16: ?media=/ph/oversize-240gsm/24.webp lands on "24/28 ·
// Army Green" with swipe arrows, the ₹190/₹228 price row and the Size Chart button on screen.
//
// COST: the whole colour index is ~1,150 chars ≈ 320 tokens — ₹0.018 per reply if it were injected
// every time. It is injected ONLY on photo/video intent (~11% of chats), so the real average is
// ₹0.002/reply against a ₹3.68 median reply. Cost was never the issue; a per-colour link TABLE in
// the static prompt would have been, which is why the index is fetched live and injected on demand.

const PHOTOS_URL = process.env.PH_PHOTOS_URL || 'https://www.bulkplaintshirt.com/phphotos.js'
const SITE = 'https://www.bulkplaintshirt.com'
const CACHE_TTL_MS = 60 * 60 * 1000
let _cache = { at: 0, data: null }

// Gallery folder → the product name buyers and the catalog use. Folders change rarely; anything
// unmapped still gets injected under its raw folder name rather than being silently dropped.
const FOLDER_NAME = {
  'oversize-180gsm': 'Oversize 180gsm', 'oversize-210gsm': 'Oversize 210gsm',
  'oversize-240gsm': 'Oversize 240gsm', 'oversize-260gsm': 'Oversize 260gsm',
  'acidwash-os': 'AcidWash Oversize', 'boxy-fit': 'Boxy Fit',
  'bio-rneck': 'Biowash Round Neck', 'true-bio-rneck': 'True Biowash Round Neck',
  'true-bio-rneck-sale': 'True Biowash Round Neck', 'non-bio-rneck': 'Non-Bio Round Neck',
  'kids-rneck': 'Kids Round Neck', 'kids-polo-sale': 'Kids Polo',
  'cotton-polo': 'Cotton Polo', 'premium-polo': 'Premium Polo',
  'hoodie-320gsm': 'Hoodie 320gsm', 'hoodie-430gsm': 'Hoodie 430gsm',
  'zip-hoodie': 'Zip Hoodie', 'sweatshirt': 'Sweatshirt', 'varsity-jacket': 'Varsity Jacket',
  'shorts': 'Shorts', 'sublimation': 'Sublimation T-shirt', 'sale-pant': 'Pants',
}

// Generous on purpose: over-firing costs ~320 cached tokens, under-firing sends the buyer the
// generic HD-photos link when we could have shown them the exact colour they asked for.
export const PHOTO_INTENT_RE = /\b(photo|photos|foto|pic|pics|picture|image|images|video|videos|reel|dikha|dikhao|dikha\s*do|dekhna|dekhau|bhej\s*do|send\s*me|hd)\b|तस्वीर|फोटो|वीडियो/i

function extractObject(src, name) {
  const i = src.indexOf(name)
  if (i < 0) return null
  const start = src.indexOf('{', i)
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let k = start; k < src.length; k++) {
    const ch = src[k]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(src.slice(start, k + 1)) }
  }
  return null
}

export async function getPhotoIndex() {
  if (_cache.data && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data
  const res = await fetch(PHOTOS_URL, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`phphotos ${res.status}`)
  const src = await res.text()
  const photos = extractObject(src, 'PH_PHOTOS') || {}
  const videos = extractObject(src, 'PH_VIDEOS') || {}
  const data = { photos, videos, fetchedAt: Date.now() }
  _cache = { at: Date.now(), data }
  return data
}

// Compact block: one line per product, each colour pointing at the FIRST photo of that colour
// (the gallery lands there and the buyer swipes to the rest of that colour's shots).
export function formatPhotoBlock(index) {
  if (!index || !index.photos) return null
  const lines = []
  for (const folder of Object.keys(index.photos)) {
    const seen = new Map()
    for (const item of index.photos[folder] || []) {
      const colour = String(item?.c || '').trim()
      const url = String(item?.u || '')
      if (!colour || !url || seen.has(colour)) continue
      const n = url.split('/').pop().replace(/\.\w+$/, '')
      seen.set(colour, n)
    }
    if (!seen.size) continue
    const name = FOLDER_NAME[folder] || folder
    lines.push(`${name} [/ph/${folder}/]: ${[...seen].map(([c, n]) => `${c}=${n}`).join(', ')}`)
  }
  const vids = []
  for (const folder of Object.keys(index.videos || {})) {
    const files = (index.videos[folder] || []).map(v => String(v?.src || '').split('/').pop()).filter(Boolean)
    if (files.length) vids.push(`${FOLDER_NAME[folder] || folder}: ${files.join(', ')}`)
  }
  if (!lines.length) return null
  return `📸 PHOTO & VIDEO DEEP LINKS (live gallery data — the buyer taps ONE link and lands on exactly that photo, with every other photo of that product swipeable beside it, plus the price and Size Chart on the same screen).
HOW TO BUILD THE LINK — photo: ${SITE}/?media=/ph/<folder>/<number>.webp using the folder and number below (e.g. Army Green 240gsm = ${SITE}/?media=/ph/oversize-240gsm/24.webp). Video: ${SITE}/?media=/ph/vid/<filename>. Whole product gallery (colour not specified): ${SITE}/?photos=<folder> — use the FOLDER name from the list below, never the display name: ${SITE}/?photos=oversize-240gsm is right, "?photos=Oversize 240gsm" is WRONG because WhatsApp stops the tappable link at the space.
WHEN: the buyer asks to SEE something — a colour's photo, a product's photos, "dikhao", "pic bhejo", a video. Send the deep link INSTEAD of the generic HD-photos link whenever you can name the product (and colour). Send ONE link only. Never paste a bare /ph/... path — always the full ${SITE}/?media=... form, or it will not open.
PHOTOS (product [folder]: colour=photo number):
${lines.join('\n')}
VIDEOS (use /ph/vid/<filename>):
${vids.join('\n') || '(none)'}
⚠️ A MISSING PHOTO IS NOT A MISSING PRODUCT. This list is only what has been photographed — it is NOT the colour range. If the buyer's colour is in the AUTHORITATIVE CATALOG but has no photo here (e.g. Oversize 240gsm Royal Blue), NEVER say the colour is unavailable: offer what exists instead — the video if one shows that colour (240gsm Royal Blue IS in oversize-240gsm-royalblue-navy.mp4), otherwise the product gallery link plus an honest line like "Is colour ka photo abhi gallery mein nahi hai sir, ek sample mangwa lijiye 👉 [product link]". The catalog decides what we sell; this block only decides what we can show. NEVER say "only this photo is available" — every ?photos= / ?media= link opens the WHOLE gallery of that product, so invite the swipe ("Is link mein saare photos hain sir, swipe karke dekh lijiye"); for a "different image / real pieces" ask, offer the live godam camera 👉 https://www.youtube.com/@BulkPlainTshirt_com/live (Ketu's own offer, 2026-09-02).`
}
