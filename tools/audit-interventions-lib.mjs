const NO_ACTION = new Set(['manual_reply', 'welcome_followup_scheduled', 'defer_superseded'])
const MEDIA = /\[(?:audio|image|video|media|product photo|document|unsupported)[^\]]*\]/i

export function isAcknowledgment(text) {
  const words = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  return words.length === 0 || words.every(w => /^(?:ok+|okay|oke|yes|ji|haan|han|hmm|thanks|thank|you|sir|bhai|bhaiya|noted|धन्यवाद|जी|हाँ|ओके)$/.test(w))
}

function numberOf(row) { return row.conversation?.whatsappNumber || '?' }
function conversationOf(row) { return row.conversation?.id || row.conversationId || numberOf(row) }
function timeOf(row) { return new Date(row.createdAt).getTime() }
function isDecision(row) {
  if (row.status === 'SKIPPED' && isAcknowledgment(row.buyerMessage) && /^(?:ai_chose_silence|conversation_ender_deterministic|conversation_ended|ender_over_pending_defer)$/.test(row.deferReason || '')) return false
  return !NO_ACTION.has(row.deferReason) && ['REPLIED', 'DEFERRED', 'FAILED', 'COOLDOWN', 'SKIPPED'].includes(row.status)
}

function contextOf(rows, row) {
  return {
    source: 'dk2_log_window',
    fullContextAvailable: false,
    completeness: 'Partial: fetched dk2 logs only; verify full thread and original media before grading.',
    promptSnapshotAvailable: !!row.promptSent,
    mediaMarkersPresent: rows.some(r => MEDIA.test(`${r.buyerMessage || ''} ${r.aiReply || ''}`)),
    mediaReview: 'not_checked',
    rows: rows.map(r => ({ id: r.id, createdAt: r.createdAt, status: r.status, deferReason: r.deferReason, buyerMessage: r.buyerMessage, aiReply: r.aiReply })),
  }
}

function candidateOf(row, manual, rows, category, sampleReason) {
  return {
    num: numberOf(row), at: row.createdAt.slice(5, 16),
    mins: manual ? Math.round((timeOf(manual) - timeOf(row)) / 60000) : null,
    buyer: row.buyerMessage || '', ai: row.aiReply || '', ketu: manual?.aiReply || '',
    logId: row.id, manualLogId: manual?.id || null, createdAt: row.createdAt,
    category, sampleReason, reviewStatus: 'unreviewed_candidate',
    status: row.status, deferReason: row.deferReason, paid: row.status === 'REPLIED' && Number(row.costUsd) > 0,
    sentViaWwbun: row.sentViaWwbun ?? null,
    context: contextOf(rows, row),
  }
}

function spreadSample(rows, count) {
  if (rows.length <= count) return rows
  return Array.from({ length: count }, (_, i) => rows[Math.floor(i * (rows.length - 1) / (count - 1))])
}

export function buildAudit(input, { since = 0, windowMinutes = 180, samplePerGroup = 12 } = {}) {
  const rows = [...new Map(input.filter(r => r?.id && Number.isFinite(timeOf(r))).map(r => [r.id, r])).values()]
    .sort((a, b) => timeOf(a) - timeOf(b) || a.id.localeCompare(b.id))
  const within = rows.filter(r => timeOf(r) >= since)
  const groups = Map.groupBy(rows, conversationOf)
  const manualCandidates = [], linked = new Set()
  let acknowledgmentCount = 0, unpairedManualCount = 0
  for (const seq of groups.values()) {
    for (let i = 0; i < seq.length; i++) {
      const manual = seq[i]
      if (manual.deferReason !== 'manual_reply' || !manual.aiReply?.trim() || timeOf(manual) < since) continue
      if (isAcknowledgment(manual.aiReply)) { acknowledgmentCount++; continue }
      let previous = null
      for (let j = i - 1; j >= 0; j--) {
        const candidate = seq[j]
        if (timeOf(manual) - timeOf(candidate) > windowMinutes * 60000) break
        if (candidate.deferReason === 'manual_reply' && !isAcknowledgment(candidate.aiReply)) break
        if (isDecision(candidate)) { previous = candidate; break }
      }
      if (!previous || linked.has(previous.id)) { unpairedManualCount++; continue }
      linked.add(previous.id)
      const category = previous.status === 'REPLIED' ? 'reply_followup'
        : previous.status === 'DEFERRED' ? 'defer_followup'
        : previous.status === 'FAILED' ? 'failed_followup'
        : previous.status === 'COOLDOWN' ? 'cooldown_followup' : 'silence_followup'
      manualCandidates.push(candidateOf(previous, manual, seq, category, 'manual_followup_requires_classification'))
    }
  }
  const interventions = manualCandidates.filter(c => c.category === 'reply_followup')
  const unsampled = within.filter(r => !linked.has(r.id) && isDecision(r))
  const sampleGroups = [
    ['silence_without_linked_manual_followup', unsampled.filter(r => r.deferReason === 'ai_chose_silence')],
    ['defer_without_linked_manual_followup', unsampled.filter(r => r.status === 'DEFERRED')],
    ['factual_reply_without_linked_manual_followup', unsampled.filter(r => r.status === 'REPLIED' && /₹|\b(?:rs\.?|days?|din|week|available|stock|same rate|weight|kg|tomorrow)\b/i.test(r.aiReply || ''))],
    ['reply_control_without_linked_manual_followup', unsampled.filter(r => r.status === 'REPLIED')],
  ]
  const samples = [], sampled = new Set()
  for (const [reason, choices] of sampleGroups) {
    for (const row of spreadSample(choices.filter(r => !sampled.has(r.id)), Math.max(2, samplePerGroup))) {
      sampled.add(row.id)
      samples.push(candidateOf(row, null, groups.get(conversationOf(row)), 'unpaired_review_sample', reason))
    }
  }
  return {
    interventions, manualCandidates, samples,
    stats: {
      rows: within.length,
      repliedRows: within.filter(r => r.status === 'REPLIED').length,
      paidReplies: within.filter(r => r.status === 'REPLIED' && Number(r.costUsd) > 0).length,
      manualRows: within.filter(r => r.deferReason === 'manual_reply').length,
      acknowledgmentCount, unpairedManualCount,
      replyFollowupCandidates: interventions.length,
      paidReplyFollowupCandidates: interventions.filter(r => r.paid).length,
      otherFollowupCandidates: manualCandidates.length - interventions.length,
      reviewSamples: samples.length,
    },
  }
}
