export function isProspectiveStockWait(text) {
  const value = String(text || '').toLowerCase().replace(/[?？.!…]+/g, ' ').replace(/\s+/g, ' ').trim()
  const match = /^(?:sir\s+)?mujhe\s+(.{1,80}?)\s+order\s+karni\s+(?:h|hai)\s+lekin\s+size\s+available\s+(?:nahi|nai|nhi)\s+(?:h|hai)\s+to\s+kab\s+tak\s+rukna\s+padega(?:\s+ya\s+pehle\s+(?:s|se)\s+order\s+laga\s+sakte\s+(?:h|hai|hain))?$/.exec(value)
  if (!match) return false
  const subject = match[1]
  if (!/\b(?:hoodie|polo|tshirt|t-shirt|sweatshirt)\b/.test(subject)) return false
  return subject.split(/\s+/).every(word => /^(?:black|white|off-white|navy|blue|red|green|grey|gray|maroon|beige|pink|yellow|brown|color|colour|ki|ka|hoodie|polo|tshirt|t-shirt|sweatshirt|cotton|premium|regular|oversize|oversized)$/.test(word))
}
