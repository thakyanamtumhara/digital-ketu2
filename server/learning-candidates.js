import { createHash } from 'node:crypto'
import { assessReplyPair, hasGarbledTranscript, hasNamedTimingSubject, isDeferLine, isMediaPlaceholder, isStockAvailabilityQuestion, isTransactionalReply, looksLikeTimingAnswer } from './stock-question.js'

const readyByDb = new WeakMap()

export async function ensureLearningCandidates(db) {
  if (!readyByDb.has(db)) {
    const ready = db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "LearningCandidate" (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT NOT NULL,
      payload JSONB NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).catch(error => { readyByDb.delete(db); throw error })
    readyByDb.set(db, ready)
  }
  await readyByDb.get(db)
}

export function learningEligibility({ buyerQuestion, correctReply, timed = false }) {
  if (!buyerQuestion?.trim() || !correctReply?.trim()) return 'missing_text'
  if (isMediaPlaceholder(buyerQuestion) || isMediaPlaceholder(correctReply)) return 'missing_media_context'
  if (hasGarbledTranscript(buyerQuestion) || hasGarbledTranscript(correctReply)) return 'garbled_transcript'
  if (isDeferLine(correctReply)) return 'holding_line'
  if (isTransactionalReply(correctReply, { forTiming: timed })) return 'transactional_reply'
  if (timed && (!isStockAvailabilityQuestion(buyerQuestion) || !looksLikeTimingAnswer(correctReply))) return 'not_stock_timing'
  if (timed && !hasNamedTimingSubject(buyerQuestion)) return 'missing_timing_subject'
  if (!timed && isStockAvailabilityQuestion(buyerQuestion)) return 'perishable_stock_answer'
  return null
}

export async function validateLearningCandidate(db, anthropic, input) {
  const trustedOrigin = ['edit', 'intervention', 'backlog', 'reviewer_manual'].includes(input.origin)
  const payload = {
    version: 1,
    author: trustedOrigin ? 'human_owner' : 'unverified',
    buyerQuestion: input.buyerQuestion,
    correctReply: input.correctReply,
    aiWrongReply: input.aiWrongReply || '',
    timed: !!input.timed,
    ...(input.timed ? { observedOn: new Date().toISOString().slice(0, 10) } : {}),
    evidence: input.evidence || {},
    validator: { model: 'claude-haiku-4-5-20251001', policy: 'explicit_yes_v1' },
  }
  const id = createHash('sha256').update(JSON.stringify([input.origin, payload])).digest('hex')
  await ensureLearningCandidates(db)
  await db.$executeRaw`
    INSERT INTO "LearningCandidate" (id, origin, status, reason, payload, "createdAt", "updatedAt")
    VALUES (${id}, ${input.origin}, 'pending', 'awaiting_validation', ${JSON.stringify(payload)}::jsonb, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `
  const [existing] = await db.$queryRaw`SELECT status FROM "LearningCandidate" WHERE id = ${id}`
  if (existing?.status === 'promoted') return { id, verdict: 'accepted', reason: 'already_promoted', alreadyPromoted: true }
  const ineligible = trustedOrigin ? learningEligibility(input) : 'untrusted_origin'
  const decision = ineligible
    ? { verdict: ['missing_media_context', 'garbled_transcript', 'missing_timing_subject'].includes(ineligible) ? 'pending' : 'rejected', reason: ineligible }
    : await assessReplyPair(anthropic, input.buyerQuestion, input.correctReply)
  const status = decision.verdict === 'accepted' ? 'validated' : decision.verdict
  await db.$executeRaw`UPDATE "LearningCandidate" SET status = ${status}, reason = ${decision.reason}, "updatedAt" = NOW() WHERE id = ${id}`
  return { id, ...decision }
}

export async function markLearningPromoted(db, id) {
  await db.$executeRaw`UPDATE "LearningCandidate" SET status = 'promoted', reason = 'stored_in_knowledge', "updatedAt" = NOW() WHERE id = ${id}`
}

export const legacyCorrectionBackfillResponse = () => ({
  status: 'disabled',
  reason: 'Legacy rows mix human corrections with unverified AI suggestions. Bulk promotion is disabled; submit human evidence through /api/correction for validation.',
})
