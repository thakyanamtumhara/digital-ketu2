export function stockMaintenanceGuard({ buyerText = '', reply = '', imageUrl = null }) {
  if (imageUrl || buyerText.length > 240 || reply.length > 150) return null
  if (/\[|https?:|[?？]|\b(?:kab|when|kya|kitna|kaise|kahan|which|how|where|need|want|price|cost|rate|refund|return|damage|dispatch|payment|reserve|hold|mere\s+liye|invoice|bill|bhej|bhejna|send|bata|batana|share|confirm|tracking|photo|catalog|chahiye|chaiye)\b|\bstock\s+(?:available\s+)?hain?\b/i.test(buyerText)) return null
  if (!/\bstock\s+(?:available\s+)?(?:rakhna|rakhiye|rakhiyega)\s*(?:please|pls|sir|bhai)?[.!\s]*$/i.test(buyerText)) return null
  if (/\[|[?？]|\b(?:nahi|nhi|not|cannot|can't|lekin|but|agar|if|refund|return|dispatch|payment|invoice)\b/i.test(reply)) return null
  if (!/\bstock\b/i.test(reply)) return null
  return 'Noted sir 🙏'
}
