const SHIPPING_CALCULATOR = 'https://www.bulkplaintshirt.com/calc/shipping-calculator.html'

export function multipartShippingGuard({ buyerText, reply, imageUrl, english = false }) {
  const ask = String(buyerText || '').normalize('NFKC')
  const answer = String(reply || '')
  if (!english || imageUrl || !answer.trim() || ask.length > 1800) return null
  if (/\[(?:DEFER|SKIP|image|photo|audio|video|document)[^\]]*\]/i.test(ask + ' ' + answer)) return null
  if (/\b(?:refund|complaint|tracking|awb|received|delayed|delay|missing|damaged|paid|payment|dispatch|return|exchange|cancel|export|international|overseas|train|porter|printer|dropship|custom)\b/i.test(ask)) return null
  const lines = ask.split(/\n/).map(line => line.replace(/^\s*[-*•\d.)]+\s*/, '').trim()).filter(Boolean)
  if (lines.length < 4 || !lines.some(line => /^(?:delivery\s*\/\s*shipping|shipping\s*\/\s*delivery|shipping|delivery)(?:\s+(?:and|&|or)\s+(?:shipping|delivery))?\s+(?:details|options|charges|costs?)[?.:!\s]*$/i.test(line))) return null
  const topics = [/\b(?:sizes?|colou?rs?)\b/i, /\b(?:prices?|rates?|MOQ|minimum order|quantity)\b/i, /\b(?:fabric|composition|fits?|designs?|pictures?|photos?|videos?)\b/i]
  if (!topics.every(topic => topic.test(ask))) return null
  if (!/https:\/\/(?:www\.)?sale91\.com\/catalog\/p\/[a-z0-9-]+\b/i.test(answer)) return null
  if (/\b(?:shipping|delivery|courier|freight|checkout|transport|dispatch|shortly)\b/i.test(answer)) return null
  return `${answer.trim()}\nShipping options and charges show at checkout; estimate charges here 👉 ${SHIPPING_CALCULATOR}`
}
