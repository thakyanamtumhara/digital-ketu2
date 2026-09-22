export function formatCloneDigest(f, rescuable = { count: 0, items: [] }) {
  const pairs = f.pairs || []
  let message = 'Digital Ketu — daily review (24h)'
  if (f.paidReplies > 0) {
    message += `\nPaid replies: ${f.paidReplies}. Your follow-ups within 25 minutes: ${f.interventions} (${f.interventionRatePct}%).`
  } else {
    message += '\nNo paid replies in this window. No quality score is available.'
  }
  message += '\nFollow-ups are review signals, not confirmed mistakes or a measure of how closely the clone matches you.'
  if (f.ackCount) message += `\n${f.ackCount} short acknowledgements were excluded.`
  if (!pairs.length) message += '\nNo qualifying follow-ups detected. Factual accuracy and your writing style still need review.'
  else {
    message += `\n\nFollow-ups to review (${pairs.length}):`
    for (const pair of pairs.slice(0, 6)) message += `\n\n• Buyer: ${String(pair.buyer || '').slice(0, 70)}\n  Clone: ${String(pair.ai || '').slice(0, 70)}\n  You: ${String(pair.ketu || '').slice(0, 70)}`
    if (pairs.length > 6) message += `\n\n…${pairs.length - 6} more.`
  }
  if (rescuable.count) {
    message += `\n\nHandoffs followed by your short answer (${rescuable.count}): review whether the clone could safely answer.`
    for (const item of (rescuable.items || []).slice(0, 5)) message += `\n\n• Buyer: ${String(item.buyer || '').slice(0, 70)}\n  You: ${String(item.ketu || '').slice(0, 70)}`
    if (rescuable.count > 5) message += `\n\n…${rescuable.count - 5} more.`
  }
  return message
}
