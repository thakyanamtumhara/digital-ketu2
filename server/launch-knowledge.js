const WOMEN = /\b(?:girls?|women(?:'?s)?|womens|ladies|female)\b/i
const OTHER_SCOPE = /\d|\b(?:kids?|child\w*|baby|boys?|unisex|crop\w*|polo|hoodie|sweatshirt|romper\w*|dress\w*|saree\w*|skirt\w*|jacket\w*)\b/i
const NEVER_COMING = /^(?:(?:girls?|women(?:'?s)?|womens|ladies|female)\s+)?(?:t[\s-]*shirts?|tees?)?\s*(?:(?:nahi|nhi)\s+(?:aayegi|aayega|aayenge|aayengi|ayegi|ayega)|(?:will\s+not|won't)\s+(?:come|launch))(?:\s+(?:sir|bhai))?[.!\s]*$/i

export function isSupersededLaunchCorrection(row) {
  if (row?.source !== 'CORRECTION') return false
  let metadata = row.metadata
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata) } catch { return false }
  }
  if (metadata?.backfilled !== true) return false
  const match = /^Buyer:\s*([\s\S]*?)\nCorrect reply:\s*([\s\S]*)$/i.exec(String(row.content || ''))
  if (!match || !WOMEN.test(match[1]) || !/\blaunch\w*\b/i.test(match[1])) return false
  if (OTHER_SCOPE.test(match[1]) || OTHER_SCOPE.test(match[2])) return false
  return NEVER_COMING.test(match[2].trim())
}
