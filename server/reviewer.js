// Self-Learning Reviewer — uses Opus 4.6 for history pull, Sonnet 4.6 for ongoing reviews
//
// Two learning modes:
// 1. AI ON: Reviews AI replies that went through Claude, rates them 1-5
//    Bad replies (≤2) → auto-corrected in DeferToKetu
// 2. AI OFF: Reviews buyer→Ketu manual reply pairs
//    Decides if AI would have handled correctly. If not → adds correction.

import Anthropic from '@anthropic-ai/sdk'
import { getEmbedding } from './embeddings.js'
import { clearFilterCache } from './process.js'

// Quality filter: both sides need 4+ words, no media/reaction placeholders
const wordCount = (s) => (s || '').split(/\s+/).filter(w => w.length > 0).length
const isQualityPair = (buyer, reply) => {
  if (!buyer || !reply) return false
  if (wordCount(buyer) < 4 || wordCount(reply) < 4) return false
  // Skip reactions, audio, media placeholders
  if (/^\[/.test(buyer) || /^\[/.test(reply)) return false
  return true
}

const REVIEWER_MODEL = 'claude-opus-4-6' // Opus 4.6 — best quality, used for manual "Run Now" reviews
const HISTORY_PULL_MODEL = 'claude-opus-4-6' // Opus 4.6 for one-time history pulls
const BATCH_SIZE = 20
const HISTORY_PULL_BATCH_SIZE = 50 // Bigger batches for history pull — more context per call

// Pricing (per token)
const SONNET_INPUT_PRICE = 3.0 / 1_000_000   // $3 per 1M input tokens
const SONNET_OUTPUT_PRICE = 15.0 / 1_000_000  // $15 per 1M output tokens
const OPUS_INPUT_PRICE = 5.0 / 1_000_000      // $5 per 1M input tokens (Opus 4.6)
const OPUS_OUTPUT_PRICE = 25.0 / 1_000_000    // $25 per 1M output tokens (Opus 4.6)

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

CATEGORIZE each message into one of: order_issue, payment, delivery, complaint, pricing, product_inquiry, website, greeting, informing, other.

RESPOND WITH ONLY VALID JSON — no markdown, no explanation:
[
  { "id": "MESSAGE_ID", "rating": 4, "category": "product_inquiry", "reason": "Good reply, natural tone", "suggestedReply": null },
  { "id": "MESSAGE_ID", "rating": 2, "category": "website", "reason": "Buyer said site not working, AI suggested visiting site", "suggestedReply": "Sir, thodi der baad try kariye. Network ka issue hoga." }
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
    const text = response.content[0].text
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    results = JSON.parse(jsonMatch ? jsonMatch[0] : text)
  } catch (err) {
    console.error('[Reviewer] Failed to parse JSON response:', err.message)
    console.error('[Reviewer] Raw response:', response.content[0].text?.substring(0, 500))
    return { reviewed: 0, corrections: 0, flagged: 0, costUsd }
  }

  let corrections = 0, flagged = 0

  for (const result of results) {
    const msg = messages.find(m => m.id === result.id)
    if (!msg) continue

    // Auto-correct bad replies (only for quality pairs with 4+ words on both sides)
    if (result.rating <= 2 && result.suggestedReply && isQualityPair(msg.buyerMessage, result.suggestedReply)) {
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

CATEGORIZE each pair into one of these categories:
- order_issue (missing items, wrong items, damage, replacement, order modification)
- payment (payment confirmation, refund, dispute, advance payment)
- delivery (tracking, dispatch status, courier issues, delivery timing)
- complaint (angry buyer, frustration, quality issue, service complaint)
- pricing (custom pricing, bulk deals, discount requests, negotiation)
- product_inquiry (rates, colors, sizes, availability, MOQ, catalog)
- website (site issues, ordering help, technical problems)
- greeting (hello, hi, welcome, casual chat)
- informing (buyer sharing info, confirming purchase, future plans)
- other (anything that doesn't fit above)

RESPOND WITH ONLY VALID JSON — no markdown, no explanation:
[
  { "id": "PAIR_ID", "aiWouldFail": true, "category": "order_issue", "reason": "Order damage complaint — AI cannot handle replacements" },
  { "id": "PAIR_ID", "aiWouldFail": false, "category": "product_inquiry", "reason": "Simple product inquiry — AI has this in knowledge base" }
]`

export async function reviewManualPairs(db, { model, batchSize } = {}) {
  const useModel = model || REVIEWER_MODEL
  const useBatchSize = batchSize || BATCH_SIZE
  const isOpus = useModel.includes('opus')
  const inputPrice = isOpus ? OPUS_INPUT_PRICE : SONNET_INPUT_PRICE
  const outputPrice = isOpus ? OPUS_OUTPUT_PRICE : SONNET_OUTPUT_PRICE

  const pairs = await db.manualReplyPair.findMany({
    where: { reviewedAt: null },
    orderBy: { createdAt: 'desc' },
    take: useBatchSize,
  })

  if (pairs.length === 0) return { reviewed: 0, corrections: 0, costUsd: 0 }

  let userPrompt = 'MANUAL REPLY PAIRS TO REVIEW:\n\n'
  for (const pair of pairs) {
    userPrompt += `--- Pair ID: ${pair.id} ---\n`
    userPrompt += `Buyer: ${pair.buyerMessage}\nKetu replied: ${pair.ketuReply}\n\n`
  }

  const anthropic = new Anthropic()
  const response = await anthropic.messages.create({
    model: useModel,
    max_tokens: 4000,
    system: MANUAL_REVIEW_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const costUsd = (response.usage.input_tokens * inputPrice) +
                  (response.usage.output_tokens * outputPrice)

  let results
  try {
    const text = response.content[0].text
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    results = JSON.parse(jsonMatch ? jsonMatch[0] : text)
  } catch (err) {
    console.error('[Reviewer] Failed to parse manual review JSON:', err.message)
    console.error('[Reviewer] Raw response:', response.content[0].text?.substring(0, 500))
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

    if (result.aiWouldFail && isQualityPair(pair.buyerMessage, pair.ketuReply)) {
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

    // Still record the review result and category even for low-quality pairs (for analytics)
    const wouldBeCorrection = result.aiWouldFail && isQualityPair(pair.buyerMessage, pair.ketuReply)
    await db.manualReplyPair.update({
      where: { id: pair.id },
      data: {
        reviewedAt: new Date(),
        reviewResult: wouldBeCorrection ? 'correction_added' : result.aiWouldFail ? 'skipped' : 'ai_would_handle',
        reviewNote: result.aiWouldFail && !isQualityPair(pair.buyerMessage, pair.ketuReply)
          ? 'Skipped — low quality pair (under 4 words or media placeholder)'
          : (result.reason || null),
        category: result.category || null,
      },
    })
  }

  console.log(`[Reviewer] Manual pairs: ${pairs.length} reviewed, ${corrections} corrections, $${costUsd.toFixed(4)} cost`)
  return { reviewed: pairs.length, corrections, costUsd }
}

// ===========================
// History Pull: Fetch pairs from wwbun + review in batches
// ===========================

export async function pullAndReviewHistory(db, onProgress, { limit = 1000 } = {}) {
  // Use Opus for history pull (one-time, best quality for Hindi/Hinglish understanding)
  const historyModel = HISTORY_PULL_MODEL
  console.log(`[HistoryPull] Using model: ${historyModel}, limit: ${limit}`)
  const WWBUN_API_URL = process.env.WWBUN_API_URL
  const DIGITAL_KETU_SECRET = process.env.DIGITAL_KETU_SECRET

  if (!WWBUN_API_URL || !DIGITAL_KETU_SECRET) {
    throw new Error('WWBUN_API_URL or DIGITAL_KETU_SECRET not configured')
  }

  // Step 1: Fetch pairs from wwbun
  console.log(`[HistoryPull] Fetching ${limit} pairs from wwbun...`)
  const response = await fetch(`${WWBUN_API_URL}/api/messages/export-style-pairs?limit=${limit}`, {
    headers: { 'X-Digital-Ketu-Secret': DIGITAL_KETU_SECRET },
  })

  if (!response.ok) {
    throw new Error(`wwbun export failed: ${response.status} ${response.statusText}`)
  }

  const pairs = await response.json()
  console.log(`[HistoryPull] Fetched ${pairs.length} pairs from wwbun`)

  if (pairs.length === 0) {
    return { fetched: 0, stored: 0, reviewed: 0, corrections: 0, costUsd: 0, categories: {} }
  }

  // Step 2: Store as ManualReplyPair (skip duplicates by checking buyerMessage + ketuReply)
  let stored = 0
  for (const pair of pairs) {
    try {
      // Quality filter: skip low-quality pairs (under 4 words or media placeholders)
      if (!isQualityPair(pair.buyerMessage, pair.omReply)) continue

      // Check if this exact pair already exists
      const existing = await db.manualReplyPair.findFirst({
        where: { buyerMessage: pair.buyerMessage, ketuReply: pair.omReply },
        select: { id: true },
      })
      if (existing) continue

      await db.manualReplyPair.create({
        data: {
          whatsappNumber: 'history_pull',
          buyerMessage: pair.buyerMessage,
          ketuReply: pair.omReply,
        },
      })
      stored++
    } catch (err) {
      // Skip duplicates or errors
    }
  }

  console.log(`[HistoryPull] Stored ${stored} new pairs (${pairs.length - stored} duplicates skipped)`)

  if (onProgress) onProgress({ phase: 'stored', fetched: pairs.length, stored, reviewed: 0, corrections: 0, costUsd: 0 })

  // Step 3: Review all unreviewed pairs in batches
  let totalReviewed = 0, totalCorrections = 0, totalCostUsd = 0
  let batchNumber = 0
  const categories = {}

  while (true) {
    batchNumber++
    const result = await reviewManualPairs(db, { model: historyModel, batchSize: HISTORY_PULL_BATCH_SIZE })

    totalReviewed += result.reviewed
    totalCorrections += result.corrections
    totalCostUsd += result.costUsd

    if (onProgress) {
      onProgress({
        phase: 'reviewing',
        fetched: pairs.length,
        stored,
        batchNumber,
        totalReviewed,
        totalCorrections,
        totalCostUsd,
      })
    }

    console.log(`[HistoryPull] Batch ${batchNumber}: +${result.reviewed} reviewed, +${result.corrections} corrections, $${totalCostUsd.toFixed(4)} cost`)

    if (result.reviewed === 0) break

    // Small delay between batches
    await new Promise(r => setTimeout(r, 2000))
  }

  // Step 4: Aggregate category stats
  const categoryStats = await db.manualReplyPair.groupBy({
    by: ['category'],
    where: { category: { not: null } },
    _count: { id: true },
  })
  for (const stat of categoryStats) {
    if (stat.category) categories[stat.category] = stat._count.id
  }

  console.log(`[HistoryPull] Complete: ${pairs.length} fetched, ${stored} stored, ${totalReviewed} reviewed, ${totalCorrections} corrections, $${totalCostUsd.toFixed(4)} cost`)
  console.log(`[HistoryPull] Categories:`, categories)

  // Step 5: Extract keywords from reviewed pairs for Pre-AI filter discovery
  let keywordsDiscovered = { autoAdded: 0, pending: 0, total: 0 }
  try {
    if (onProgress) onProgress({ phase: 'discovering_keywords', fetched: pairs.length, stored, totalReviewed, totalCorrections, totalCostUsd })
    keywordsDiscovered = await extractKeywordsFromReviewedPairs(db, { model: historyModel })
    console.log(`[HistoryPull] Keywords: ${keywordsDiscovered.total} discovered, ${keywordsDiscovered.autoAdded} auto-added, ${keywordsDiscovered.pending} pending review`)
  } catch (err) {
    console.error(`[HistoryPull] Keyword extraction failed (non-fatal):`, err.message)
  }

  return {
    fetched: pairs.length,
    stored,
    reviewed: totalReviewed,
    corrections: totalCorrections,
    costUsd: totalCostUsd,
    batches: batchNumber - 1,
    categories,
    keywordsDiscovered,
  }
}

// ===========================
// Keyword Extraction from Reviewed Pairs
// ===========================
// After reviewing pairs, extract keywords that could be used as Pre-AI filters.
// High-confidence keywords for existing categories → auto-added.
// Low-confidence or new categories → pending manual review.
// Pass 2 of smart 2-pass approach: Opus sees ALL reviewed pairs for deep pattern analysis.

async function extractKeywordsFromReviewedPairs(db, { model } = {}) {
  const useModel = model || REVIEWER_MODEL
  // Get ALL reviewed pairs — Opus 4.6 has 200K context, can handle 1000+ pairs
  // This is the key insight: seeing ALL pairs lets the model find patterns across the full dataset
  const recentPairs = await db.manualReplyPair.findMany({
    where: { reviewedAt: { not: null }, category: { not: null } },
    orderBy: { reviewedAt: 'desc' },
    take: 2000, // Get all available reviewed pairs (up to 2000)
    select: { buyerMessage: true, category: true },
  })

  console.log(`[KeywordExtract] Loaded ${recentPairs.length} reviewed pairs for deep analysis with ${useModel}`)

  if (recentPairs.length < 10) return { autoAdded: 0, pending: 0, total: 0 }

  // Group by category
  const byCategory = {}
  for (const pair of recentPairs) {
    if (!byCategory[pair.category]) byCategory[pair.category] = []
    byCategory[pair.category].push(pair.buyerMessage)
  }

  // Load existing filters to know what categories exist
  let existingFilters = []
  try {
    existingFilters = await db.preAIFilter.findMany()
  } catch {
    return { autoAdded: 0, pending: 0, total: 0 }
  }
  const existingNames = existingFilters.map(f => f.name)
  const existingKeywordsMap = {}
  for (const f of existingFilters) {
    existingKeywordsMap[f.name] = f.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
  }

  // Build prompt with all categories and ALL messages (Opus 4.6 has 200K context)
  // Show up to 50 messages per category for deep pattern analysis
  const categorySections = Object.entries(byCategory)
    .map(([cat, msgs]) => `### ${cat} (${msgs.length} messages)\n${msgs.slice(0, 50).map(m => `- "${m}"`).join('\n')}${msgs.length > 50 ? `\n... and ${msgs.length - 50} more similar messages` : ''}`)
    .join('\n\n')

  console.log(`[KeywordExtract] Categories: ${Object.entries(byCategory).map(([c, m]) => `${c}(${m.length})`).join(', ')}`)

  const existingKwSection = existingFilters
    .map(f => `- ${f.name}: ${f.keywords.split(',').slice(0, 10).join(', ')}${f.keywords.split(',').length > 10 ? '...' : ''}`)
    .join('\n')

  const prompt = `You analyze buyer messages from a wholesale blank t-shirt business (BulkPlainTshirt.com).

Existing Pre-AI filter categories and their current keywords:
${existingKwSection || 'None yet'}

Buyer messages grouped by category from recent conversations:
${categorySections}

Extract SHORT keywords/phrases (1-3 words, Hindi/English/Hinglish) that could be used as Pre-AI filters.

Rules:
1. Only include keywords NOT already in the existing lists above
2. Must be specific enough to avoid false positives (don't use common words like "hai", "kya", "please")
3. Include Hinglish variants
4. Assign confidence 0.0-1.0:
   - 0.9+ = Very sure this keyword uniquely identifies the category
   - 0.7-0.89 = Fairly sure but could occasionally match other categories
   - Below 0.7 = Uncertain, needs human review
5. For categories not in the existing list, still extract keywords with the category name

Reply as JSON array only: [{ "keyword": "...", "category": "...", "confidence": 0.95 }]`

  const anthropic = new Anthropic()
  console.log(`[KeywordExtract] Using model: ${useModel}`)
  const response = await anthropic.messages.create({
    model: useModel,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  })

  let discoveries
  try {
    const text = response.content[0].text
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    discoveries = JSON.parse(jsonMatch ? jsonMatch[0] : text)
  } catch {
    console.error('[KeywordExtract] Failed to parse Sonnet response')
    return { autoAdded: 0, pending: 0, total: 0 }
  }

  let autoAdded = 0, pending = 0

  // --- CROSS-VALIDATION: Count how many distinct messages each keyword actually appears in ---
  // This ensures we don't trust a keyword that only appeared in 1 message
  const keywordFrequency = {}
  for (const d of discoveries) {
    if (!d.keyword || !d.category) continue
    const kw = d.keyword.toLowerCase().trim()
    const cat = d.category
    const key = `${kw}|||${cat}`

    if (!keywordFrequency[key]) {
      keywordFrequency[key] = { keyword: kw, category: cat, count: 0 }
    }

    // Count how many messages in this category actually contain this keyword
    const categoryMessages = byCategory[cat] || []
    let matchCount = 0
    for (const msg of categoryMessages) {
      if (msg.toLowerCase().includes(kw)) matchCount++
    }
    keywordFrequency[key].count = matchCount
  }

  console.log('[KeywordExtract] Cross-validation frequency counts:')
  for (const [key, info] of Object.entries(keywordFrequency)) {
    console.log(`  "${info.keyword}" (${info.category}): found in ${info.count}/${(byCategory[info.category] || []).length} messages`)
  }

  for (const d of discoveries) {
    if (!d.keyword || !d.category) continue

    const keyword = d.keyword.toLowerCase().trim()
    const targetFilter = existingFilters.find(f => f.name === d.category)

    // Skip if keyword already exists in the target filter
    if (targetFilter && existingKeywordsMap[d.category]?.includes(keyword)) continue

    // Check if this keyword was already discovered before
    const existingDiscovery = await db.discoveredKeyword.findFirst({
      where: { keyword, category: d.category },
    })
    if (existingDiscovery) continue

    // --- CROSS-VALIDATION CHECK ---
    // Keyword must appear in at least 2 different messages of the same category
    // If it only appears in 1 message, it might be a one-off word, not a reliable filter keyword
    const freqKey = `${keyword}|||${d.category}`
    const freq = keywordFrequency[freqKey]
    const messageCount = freq ? freq.count : 0
    const MIN_FREQUENCY = 2 // Must appear in at least 2 messages

    if (messageCount < MIN_FREQUENCY) {
      console.log(`[KeywordExtract] SKIPPED "${keyword}" (${d.category}): only in ${messageCount} message(s), need ${MIN_FREQUENCY}+`)
      continue
    }

    // Boost or penalize confidence based on actual frequency
    // More messages = more reliable keyword
    const categoryTotal = (byCategory[d.category] || []).length
    const frequencyRatio = categoryTotal > 0 ? messageCount / categoryTotal : 0
    // If keyword appears in 50%+ of messages in category, boost confidence
    // If keyword appears in <20% of messages, reduce confidence
    let adjustedConfidence = d.confidence
    if (frequencyRatio >= 0.5) adjustedConfidence = Math.min(1.0, d.confidence + 0.05)
    else if (frequencyRatio < 0.2) adjustedConfidence = Math.max(0, d.confidence - 0.10)

    console.log(`[KeywordExtract] "${keyword}" (${d.category}): AI=${d.confidence.toFixed(2)}, freq=${messageCount}/${categoryTotal} (${(frequencyRatio * 100).toFixed(0)}%), adjusted=${adjustedConfidence.toFixed(2)}`)

    // AUTO-ADD: High adjusted confidence + existing category + verified across multiple messages
    if (adjustedConfidence >= 0.85 && existingNames.includes(d.category) && targetFilter) {
      const updatedKeywords = targetFilter.keywords
        ? targetFilter.keywords + ',' + keyword
        : keyword

      await db.preAIFilter.update({
        where: { id: targetFilter.id },
        data: { keywords: updatedKeywords },
      })

      // Update local cache
      existingKeywordsMap[d.category].push(keyword)
      targetFilter.keywords = updatedKeywords

      await db.discoveredKeyword.create({
        data: {
          keyword,
          category: d.category,
          confidence: adjustedConfidence,
          source: 'auto_review',
          status: 'auto_added',
          filterId: targetFilter.id,
          processedAt: new Date(),
        },
      })
      autoAdded++
      console.log(`[KeywordExtract] AUTO-ADDED "${keyword}" → ${d.category} (confidence=${adjustedConfidence.toFixed(2)}, verified in ${messageCount} messages)`)
    } else {
      // MANUAL REVIEW: Low confidence OR new category
      await db.discoveredKeyword.create({
        data: {
          keyword,
          category: d.category,
          confidence: adjustedConfidence,
          source: 'auto_review',
          status: 'pending',
        },
      })
      console.log(`[KeywordExtract] PENDING "${keyword}" → ${d.category} (confidence=${adjustedConfidence.toFixed(2)}, verified in ${messageCount} messages)`)
      pending++
    }
  }

  if (autoAdded > 0) clearFilterCache()

  return { autoAdded, pending, total: autoAdded + pending }
}

// ===========================
// Combined Review Job
// ===========================

export async function runReviewJob(db) {
  const aiResult = await reviewAiReplies(db)
  const manualResult = await reviewManualPairs(db)

  let totalCost = aiResult.costUsd + manualResult.costUsd

  // Extract keywords from reviewed pairs (same as history pull)
  let keywordsDiscovered = { autoAdded: 0, pending: 0, total: 0 }
  if (manualResult.reviewed > 0) {
    try {
      keywordsDiscovered = await extractKeywordsFromReviewedPairs(db)
      console.log(`[RunNow] Keywords: ${keywordsDiscovered.total} discovered, ${keywordsDiscovered.autoAdded} auto-added, ${keywordsDiscovered.pending} pending`)
    } catch (err) {
      console.error(`[RunNow] Keyword extraction failed (non-fatal):`, err.message)
    }
  }

  return {
    aiReplies: aiResult,
    manualPairs: manualResult,
    totalCostUsd: totalCost,
    keywordsDiscovered,
  }
}

// ===========================
// Backlog Review (one-time)
// ===========================
// Reviews ALL past AI replies that haven't been reviewed yet.
// Processes in batches of 20 with progress tracking.

export async function reviewBacklog(db, onProgress) {
  let totalReviewed = 0, totalCorrections = 0, totalFlagged = 0, totalCostUsd = 0
  let batchNumber = 0

  while (true) {
    batchNumber++
    const result = await reviewAiReplies(db)

    totalReviewed += result.reviewed
    totalCorrections += result.corrections
    totalFlagged += result.flagged
    totalCostUsd += result.costUsd

    // Report progress
    if (onProgress) {
      onProgress({
        batchNumber,
        totalReviewed,
        totalCorrections,
        totalFlagged,
        totalCostUsd,
        batchReviewed: result.reviewed,
      })
    }

    console.log(`[Backlog] Batch ${batchNumber}: +${result.reviewed} reviewed, +${result.corrections} corrections, total cost $${totalCostUsd.toFixed(4)}`)

    // Stop when no more unreviewed messages
    if (result.reviewed === 0) break

    // Small delay between batches to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000))
  }

  console.log(`[Backlog] Complete: ${totalReviewed} reviewed, ${totalCorrections} corrections, ${totalFlagged} flagged, $${totalCostUsd.toFixed(4)} total cost`)
  return { totalReviewed, totalCorrections, totalFlagged, totalCostUsd, batches: batchNumber - 1 }
}
