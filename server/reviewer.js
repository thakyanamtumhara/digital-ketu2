// Self-Learning Reviewer — uses Sonnet 4.6 to review Haiku's replies and manual pairs
//
// Two learning modes:
// 1. AI ON: Reviews AI replies that went through Claude, rates them 1-5
//    Bad replies (≤2) → auto-corrected in DeferToKetu
// 2. AI OFF: Reviews buyer→Ketu manual reply pairs
//    Decides if AI would have handled correctly. If not → adds correction.

import Anthropic from '@anthropic-ai/sdk'
import { getEmbedding } from './embeddings.js'

const REVIEWER_MODEL = 'claude-sonnet-4-6-20250514'
const BATCH_SIZE = 20

// Sonnet pricing (per token)
const SONNET_INPUT_PRICE = 3.0 / 1_000_000   // $3 per 1M input tokens
const SONNET_OUTPUT_PRICE = 15.0 / 1_000_000  // $15 per 1M output tokens

// ===========================
// Mode 1: Review AI Replies
// ===========================

const AI_REVIEW_SYSTEM_PROMPT = `You are a quality reviewer for a WhatsApp AI assistant that handles buyers for a wholesale blank t-shirt business (BulkPlainTshirt.com / sale91.com).

BUSINESS CONTEXT:
- Wholesale blank apparel: t-shirts, hoodies, sweatshirts, polo, shorts
- Buyers are shopkeepers/retailers from across India
- Owner is Ketu. Communication: casual, friendly, Hinglish, 10-15 words max
- Prices are FIXED, no discounts. Orders via sale91.com
- AI CANNOT check order status, tracking, payments — must [DEFER] for those

REVIEW EACH REPLY — rate 1 to 5:
5 = Perfect reply, natural and helpful
4 = Good, minor improvements possible
3 = Okay but could confuse the buyer or missed a nuance
2 = Bad — wrong tone, wrong info, or missed buyer's intent
1 = Terrible — completely wrong, hallucinated, or would damage relationship

COMMON FAILURES TO WATCH:
- Suggesting sale91.com when buyer says the site isn't working
- Trying to handle order issues instead of [DEFER]ing
- Offering discounts (prices are fixed)
- Hallucinating product details not in knowledge base
- Too verbose (should be 10-15 words)
- Using informal tu/tum forms instead of polite aap forms
- Repeating sale91.com when already shared in conversation
- Not recognizing buyer is just informing (should acknowledge briefly)
- Not recognizing angry buyer (should defer)

For rating ≤ 3, suggest the correct reply in the same language/style as the buyer.

RESPOND WITH ONLY VALID JSON — no markdown, no explanation:
[
  { "id": "MESSAGE_ID", "rating": 4, "reason": "Good reply, natural tone", "suggestedReply": null },
  { "id": "MESSAGE_ID", "rating": 2, "reason": "Buyer said site not working, AI suggested visiting site", "suggestedReply": "Sir, thodi der baad try kariye. Network ka issue hoga." }
]`

export async function reviewAiReplies(db) {
  const messages = await db.messageLog.findMany({
    where: {
      status: 'REPLIED',
      totalTokens: { gt: 0 },
      reviewedAt: null,
      deferReason: null,  // skip pre-filtered messages
    },
    orderBy: { createdAt: 'desc' },
    take: BATCH_SIZE,
    include: { conversation: true },
  })

  if (messages.length === 0) return { reviewed: 0, corrections: 0, flagged: 0, costUsd: 0 }

  // Build prompt with conversation context
  let userPrompt = 'MESSAGES TO REVIEW:\n\n'
  for (const msg of messages) {
    // Get last 3 conversation messages for context
    const history = await db.messageLog.findMany({
      where: {
        conversationId: msg.conversationId,
        createdAt: { lt: msg.createdAt },
        status: 'REPLIED',
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { buyerMessage: true, aiReply: true },
    })

    userPrompt += `--- Message ID: ${msg.id} ---\n`
    if (history.length > 0) {
      userPrompt += 'Recent conversation:\n'
      for (const h of history.reverse()) {
        userPrompt += `  Buyer: ${h.buyerMessage}\n  AI: ${h.aiReply}\n`
      }
    }
    userPrompt += `Buyer: ${msg.buyerMessage}\nAI replied: ${msg.aiReply}\n\n`
  }

  const anthropic = new Anthropic()
  const response = await anthropic.messages.create({
    model: REVIEWER_MODEL,
    max_tokens: 4000,
    system: AI_REVIEW_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const costUsd = (response.usage.input_tokens * SONNET_INPUT_PRICE) +
                  (response.usage.output_tokens * SONNET_OUTPUT_PRICE)

  let results
  try {
    results = JSON.parse(response.content[0].text)
  } catch (err) {
    console.error('[Reviewer] Failed to parse JSON response:', err.message)
    return { reviewed: 0, corrections: 0, flagged: 0, costUsd }
  }

  let corrections = 0, flagged = 0

  for (const result of results) {
    const msg = messages.find(m => m.id === result.id)
    if (!msg) continue

    // Auto-correct bad replies
    if (result.rating <= 2 && result.suggestedReply) {
      try {
        const embedding = await getEmbedding(null, msg.buyerMessage)
        await db.$executeRaw`
          INSERT INTO "DeferToKetu" (id, "buyerQuestion", "aiWrongReply", "correctReply", embedding, "triggerCount", "createdAt", "updatedAt")
          VALUES (${crypto.randomUUID()}, ${msg.buyerMessage}, ${msg.aiReply}, ${result.suggestedReply}, ${embedding}::vector, 0, NOW(), NOW())
        `
        corrections++
      } catch (err) {
        console.error(`[Reviewer] Failed to add correction for ${msg.id}:`, err.message)
      }
    }

    if (result.rating === 3) flagged++

    // Mark as reviewed
    await db.messageLog.update({
      where: { id: msg.id },
      data: {
        reviewedAt: new Date(),
        reviewRating: result.rating,
        reviewNote: result.reason || null,
      },
    })
  }

  console.log(`[Reviewer] AI replies: ${messages.length} reviewed, ${corrections} corrected, ${flagged} flagged, $${costUsd.toFixed(4)} cost`)
  return { reviewed: messages.length, corrections, flagged, costUsd }
}

// ===========================
// Mode 2: Review Manual Pairs
// ===========================

const MANUAL_REVIEW_SYSTEM_PROMPT = `You are reviewing manual reply pairs from a wholesale blank t-shirt business (BulkPlainTshirt.com / sale91.com).

The AI assistant (Haiku) was OFF during these conversations. Ketu (the owner) replied manually.

For each buyer→Ketu pair, decide: Would the AI have handled this correctly?

THE AI CAN HANDLE:
- Product inquiries (rates, colors, sizes, MOQ, catalog)
- Greetings and casual chat
- Directing buyers to sale91.com for ordering
- Basic policies (shipping, payment, GST, minimum order)
- Brief acknowledgments ("Ok noted sir")
- Website issue reassurance

THE AI CANNOT HANDLE:
- Order-specific issues (missing items, wrong items, damage, replacement)
- Payment disputes, refund requests, payment confirmation
- Delivery tracking, courier issues, dispatch status
- Custom pricing, special bulk deals, negotiation beyond fixed prices
- Complaints or angry/frustrated buyers
- Anything requiring personal judgment or business decisions
- Adding/removing items from existing orders

RESPOND WITH ONLY VALID JSON — no markdown, no explanation:
[
  { "id": "PAIR_ID", "aiWouldFail": true, "reason": "Order damage complaint — AI cannot handle replacements" },
  { "id": "PAIR_ID", "aiWouldFail": false, "reason": "Simple product inquiry — AI has this in knowledge base" }
]`

export async function reviewManualPairs(db) {
  const pairs = await db.manualReplyPair.findMany({
    where: { reviewedAt: null },
    orderBy: { createdAt: 'desc' },
    take: BATCH_SIZE,
  })

  if (pairs.length === 0) return { reviewed: 0, corrections: 0, costUsd: 0 }

  let userPrompt = 'MANUAL REPLY PAIRS TO REVIEW:\n\n'
  for (const pair of pairs) {
    userPrompt += `--- Pair ID: ${pair.id} ---\n`
    userPrompt += `Buyer: ${pair.buyerMessage}\nKetu replied: ${pair.ketuReply}\n\n`
  }

  const anthropic = new Anthropic()
  const response = await anthropic.messages.create({
    model: REVIEWER_MODEL,
    max_tokens: 4000,
    system: MANUAL_REVIEW_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const costUsd = (response.usage.input_tokens * SONNET_INPUT_PRICE) +
                  (response.usage.output_tokens * SONNET_OUTPUT_PRICE)

  let results
  try {
    results = JSON.parse(response.content[0].text)
  } catch (err) {
    console.error('[Reviewer] Failed to parse manual review JSON:', err.message)
    // Mark all as reviewed so we don't keep retrying bad batches
    for (const pair of pairs) {
      await db.manualReplyPair.update({
        where: { id: pair.id },
        data: { reviewedAt: new Date(), reviewResult: 'skipped', reviewNote: 'JSON parse error' },
      })
    }
    return { reviewed: pairs.length, corrections: 0, costUsd }
  }

  let corrections = 0

  for (const result of results) {
    const pair = pairs.find(p => p.id === result.id)
    if (!pair) continue

    if (result.aiWouldFail) {
      try {
        const embedding = await getEmbedding(null, pair.buyerMessage)
        await db.$executeRaw`
          INSERT INTO "DeferToKetu" (id, "buyerQuestion", "aiWrongReply", "correctReply", embedding, "triggerCount", "createdAt", "updatedAt")
          VALUES (${crypto.randomUUID()}, ${pair.buyerMessage}, ${'[AI would not know]'}, ${pair.ketuReply}, ${embedding}::vector, 0, NOW(), NOW())
        `
        corrections++
      } catch (err) {
        console.error(`[Reviewer] Failed to add manual correction for ${pair.id}:`, err.message)
      }
    }

    await db.manualReplyPair.update({
      where: { id: pair.id },
      data: {
        reviewedAt: new Date(),
        reviewResult: result.aiWouldFail ? 'correction_added' : 'ai_would_handle',
        reviewNote: result.reason || null,
      },
    })
  }

  console.log(`[Reviewer] Manual pairs: ${pairs.length} reviewed, ${corrections} corrections, $${costUsd.toFixed(4)} cost`)
  return { reviewed: pairs.length, corrections, costUsd }
}

// ===========================
// Combined Review Job
// ===========================

export async function runReviewJob(db) {
  const aiResult = await reviewAiReplies(db)
  const manualResult = await reviewManualPairs(db)

  const totalCost = aiResult.costUsd + manualResult.costUsd

  return {
    aiReplies: aiResult,
    manualPairs: manualResult,
    totalCostUsd: totalCost,
  }
}
