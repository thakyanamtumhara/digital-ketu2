const CUSTOM_LABEL_VENDOR = 'https://wa.me/917808284808'

export function customLabelReferralGuard({ buyerText, reply, imageUrl, english = false }) {
  if (!english || imageUrl) return null
  const ask = String(buyerText || '').normalize('NFKC').replace(/[’‘]/g, "'").trim()
  const answer = String(reply || '').normalize('NFKC').replace(/[’‘]/g, "'")
  if (ask.length > 260 || !answer.trim() || /\[(?:DEFER|SKIP|image|photo|audio|video|document)[^\]]*\]/i.test(ask + ' ' + answer)) return null
  const text = ask.replace(/^(?:(?:hi|hello|sir)[.! ,]*)+/i, '').replace(/[?.!\s]+$/, '').replace(/\s+/g, ' ')
  const label = '(?:(?:own|brand|custom|neck) )*(?:tags?|labels?)'
  const quantity = new RegExp(`^(?:(?:may|can|could) I (?:please )?(?:know|ask) )?(?:what(?:'s| is) the )?(?:moq|minimum(?: order)? quantity) (?:for|to) (?:having|getting|adding|stitching) (?:my|our) ${label}$`, 'i')
  const service = new RegExp(`^(?:(?:can|could|do|will) you (?:please )?(?:stitch|sew|add|attach)|I (?:want|need|would like)) (?:my|our) ${label}$`, 'i')
  if (!quantity.test(text) && !service.test(text)) return null
  if (answer.includes(CUSTOM_LABEL_VENDOR) || /https?:\/\/(?:wa\.me|api\.whatsapp\.com)\//i.test(answer)) return null
  if (!/\b(?:don't|do not|can't|cannot)\b[^.!?\n]{0,65}\b(?:brand(?:ing)?|custom|tags?|labels?)\b/i.test(answer)) return null
  return `We supply plain tees with size labels sir. For custom labels, ask this independent vendor 👉 ${CUSTOM_LABEL_VENDOR}`
}
