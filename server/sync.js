// Sync module — pulls data from GitHub repos and builds knowledge base
// 1. Saved Replies from wwbun repo (Prisma schema → ReplyTemplate model)
// 2. Product Catalog from catalog repo (products.json)

import { storeChunkWithEmbedding } from './embeddings.js'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_REPO_WWBUN = process.env.GITHUB_REPO_WWBUN || 'thakyanamtumhara/wwbun'
const GITHUB_REPO_CATALOG = process.env.GITHUB_REPO_CATALOG || 'thakyanamtumhara/catalog'
// Live catalog JSON — published straight from the website's pc.js publishers, ALWAYS current.
// The GitHub repo copy goes stale (last commit 2026-04): on 2026-08-13 the live site had sold the
// new 260gsm product for days while dk2's catalog chunks — synced from the repo — still lacked it,
// so the clone answered from launch-era facts. Live first; repo only as fallback.
const LIVE_PRODUCTS_URL = process.env.LIVE_PRODUCTS_URL || 'https://www.bulkplaintshirt.com/catalog/products.json'

/**
 * Fetch a file from a GitHub repo using the GitHub API
 */
async function fetchGitHubFile(repo, path) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`
  const headers = {
    'Accept': 'application/vnd.github.v3.raw',
    'User-Agent': 'digital-ketu2-sync',
  }
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`
  }

  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} for ${repo}/${path}`)
  }
  return response.text()
}

// ===========================================
// Sync Saved Replies from wwbun
// ===========================================

/**
 * The wwbun repo stores saved replies as ReplyTemplate records in PostgreSQL.
 * Since we can't access wwbun's DB directly, we read the Prisma schema to understand
 * the structure, then use the wwbun API to fetch templates.
 *
 * Alternative: If wwbun exposes a /api/templates endpoint, we call that.
 * Fallback: Read template data from a JSON export file in the repo.
 */
export async function syncSavedReplies(db, anthropic) {
  const startTime = Date.now()
  let itemsFound = 0, itemsNew = 0, itemsUpdated = 0

  try {
    // Try fetching from wwbun API first (if accessible on Railway internal network)
    const WWBUN_API_URL = process.env.WWBUN_API_URL
    const DIGITAL_KETU_SECRET = process.env.DIGITAL_KETU_SECRET

    let templates = []

    if (WWBUN_API_URL && DIGITAL_KETU_SECRET) {
      // Fetch templates from wwbun API (secret-authenticated export endpoint)
      const response = await fetch(`${WWBUN_API_URL}/api/templates/export`, {
        headers: {
          'X-Digital-Ketu-Secret': DIGITAL_KETU_SECRET,
        },
      })
      if (response.ok) {
        templates = await response.json()
        console.log(`[Sync] Fetched ${templates.length} templates from wwbun`)
      } else {
        console.warn(`[Sync] wwbun templates export failed: ${response.status} ${response.statusText}`)
      }
    }

    if (templates.length === 0) {
      // Fallback: try reading llms.txt from catalog repo which has FAQ/knowledge
      console.log('[Sync] No templates from wwbun API, trying catalog llms.txt fallback')
      const llmsContent = await fetchGitHubFile(GITHUB_REPO_CATALOG, 'llms.txt')
      if (llmsContent) {
        // Parse llms.txt into knowledge chunks
        const sections = parseLlmsTxt(llmsContent)
        for (const section of sections) {
          const result = await storeChunkWithEmbedding(db, anthropic, {
            source: 'SAVED_REPLY',
            sourceId: `llms_${section.id}`,
            title: section.title,
            content: section.content,
            metadata: { source: 'llms.txt' },
          })
          itemsFound++
          if (result.action === 'created') itemsNew++
          else itemsUpdated++
        }
      }
    } else {
      // Process wwbun templates (pre-cleaned by wwbun API — no catalog-redundant, temp, or internal templates)
      itemsFound = templates.length
      for (const template of templates) {
        const content = template.content || ''
        const shortcut = template.shortcut || ''
        const category = template.category || 'general'
        const title = shortcut ? `/${shortcut} (${category})` : `Template ${template.id}`

        const result = await storeChunkWithEmbedding(db, anthropic, {
          source: 'SAVED_REPLY',
          sourceId: `template_${template.id}`,
          title,
          content,
          metadata: {
            shortcut,
            category,
            hasMedia: !!template.mediaUrl,
            mediaType: template.mediaType || null,
          },
        })
        if (result.action === 'created') itemsNew++
        else itemsUpdated++
      }
    }

    // Log sync result
    await db.syncLog.create({
      data: {
        syncType: 'saved_replies',
        status: 'success',
        itemsFound,
        itemsNew,
        itemsUpdated,
        durationMs: Date.now() - startTime,
      },
    })

    console.log(`[Sync] Saved replies: ${itemsFound} found, ${itemsNew} new, ${itemsUpdated} updated`)
    return { status: 'success', itemsFound, itemsNew, itemsUpdated }

  } catch (err) {
    await db.syncLog.create({
      data: {
        syncType: 'saved_replies',
        status: 'failed',
        error: err.message,
        durationMs: Date.now() - startTime,
      },
    })
    console.error('[Sync] Saved replies failed:', err.message)
    throw err
  }
}

// ===========================================
// Sync Product Catalog
// ===========================================

export async function syncCatalog(db, anthropic) {
  const startTime = Date.now()
  let itemsFound = 0, itemsNew = 0, itemsUpdated = 0

  try {
    // Fetch products.json from the LIVE site first (see LIVE_PRODUCTS_URL note above)
    let rawJson
    try {
      const res = await fetch(LIVE_PRODUCTS_URL, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`live products.json ${res.status}`)
      rawJson = await res.text()
    } catch (liveErr) {
      console.warn(`[Sync] live products.json failed (${liveErr.message}) — falling back to GitHub repo copy`)
      rawJson = await fetchGitHubFile(GITHUB_REPO_CATALOG, 'products.json')
    }
    const catalogData = JSON.parse(rawJson)

    // Products are nested inside categories: categories[].products[]
    const products = (catalogData.categories || []).flatMap(cat =>
      (cat.products || []).map(p => ({ ...p, category: cat.name }))
    )

    itemsFound = products.length

    for (const product of products) {
      // Build a rich text description for embedding
      const description = buildProductDescription(product, catalogData)

      const result = await storeChunkWithEmbedding(db, anthropic, {
        source: 'CATALOG',
        sourceId: `product_${product.slug}`,
        title: product.name,
        content: description,
        metadata: {
          slug: product.slug,
          name: product.name,
          // Live products.json uses bulkPriceFrom/To; the flat fields were retired, so these were
          // silently undefined and JSON.stringify dropped them (audit 2026-08-27). The chunk TEXT
          // already carries the correct price, so this was cosmetic — but the metadata price
          // emitter in buildUserPrompt reads these, and was therefore dead.
          bulkPrice: product.bulkPriceFrom ?? product.bulkPrice ?? null,
          bulkPriceTo: product.bulkPriceTo ?? product.bulkPrice ?? null,
          samplePrice: product.samplePriceFrom ?? product.samplePrice ?? null,
          samplePriceTo: product.samplePriceTo ?? product.samplePrice ?? null,
          gsm: product.gsm,
          colors: product.colors,
          sizes: product.sizes,
          category: product.category,
        },
      })
      if (result.action === 'created') itemsNew++
      else itemsUpdated++
    }

    // Also store general policies as knowledge chunks
    await storeChunkWithEmbedding(db, anthropic, {
      source: 'POLICY',
      sourceId: 'general_policies',
      title: 'General Business Policies',
      content: buildPoliciesChunk(catalogData),
      metadata: { type: 'policies' },
    })

    await db.syncLog.create({
      data: {
        syncType: 'catalog',
        status: 'success',
        itemsFound,
        itemsNew,
        itemsUpdated,
        durationMs: Date.now() - startTime,
      },
    })

    console.log(`[Sync] Catalog: ${itemsFound} products, ${itemsNew} new, ${itemsUpdated} updated`)
    return { status: 'success', itemsFound, itemsNew, itemsUpdated }

  } catch (err) {
    await db.syncLog.create({
      data: {
        syncType: 'catalog',
        status: 'failed',
        error: err.message,
        durationMs: Date.now() - startTime,
      },
    })
    console.error('[Sync] Catalog failed:', err.message)
    throw err
  }
}

// ===========================================
// Sync Om's Real Reply Pairs from wwbun
// ===========================================

export async function syncStylePairs(db, anthropic) {
  const startTime = Date.now()
  let itemsFound = 0, itemsNew = 0, itemsUpdated = 0

  try {
    const WWBUN_API_URL = process.env.WWBUN_API_URL
    const DIGITAL_KETU_SECRET = process.env.DIGITAL_KETU_SECRET

    if (!WWBUN_API_URL || !DIGITAL_KETU_SECRET) {
      throw new Error('WWBUN_API_URL or DIGITAL_KETU_SECRET not configured')
    }

    // Step 1: Fetch quality reply pairs from wwbun
    const response = await fetch(`${WWBUN_API_URL}/api/messages/export-style-pairs?limit=1000`, {
      headers: { 'X-Digital-Ketu-Secret': DIGITAL_KETU_SECRET },
    })

    if (!response.ok) {
      throw new Error(`wwbun style pairs export failed: ${response.status} ${response.statusText}`)
    }

    const pairs = await response.json()
    itemsFound = pairs.length
    console.log(`[Sync] Fetched ${pairs.length} quality style pairs from wwbun`)

    if (pairs.length === 0) {
      await db.syncLog.create({
        data: { syncType: 'style_pairs', status: 'success', itemsFound: 0, itemsNew: 0, itemsUpdated: 0, durationMs: Date.now() - startTime },
      })
      return { status: 'success', itemsFound: 0, itemsNew: 0, itemsUpdated: 0 }
    }

    // Step 2: Send ALL pairs to Claude ONCE to extract a compact style guide
    const pairsText = pairs.map((p, i) => `${i + 1}. Buyer: "${p.buyerMessage}" → Om: "${p.omReply}"`).join('\n')

    const styleResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Analyze these ${pairs.length} real WhatsApp reply pairs from Om (a wholesale t-shirt business owner). Extract a COMPACT style guide that captures how Om communicates.

${pairsText}

Write a style guide covering ONLY communication style (not content/knowledge):
1. Average reply length (word count)
2. Language preference (Hindi/English/Hinglish mix)
3. Tone and formality level
4. Common phrases and words Om uses frequently
5. What Om avoids saying
6. Key patterns (does he use emojis? punctuation? greetings?)

DO NOT include these scenarios (they are handled separately):
- Pricing info (comes from product catalog)
- Product specifications (comes from product catalog)
- Logistics/tracking (deferred to Ketu/human)

Focus purely on HOW Om writes, not WHAT info he gives. Keep the guide under 150 words. Be specific with examples from the data. This guide will be injected into an AI system prompt to mimic Om's style.`
      }],
    })

    const styleGuide = styleResponse.content[0].text
    const styleTokens = styleResponse.usage.input_tokens + styleResponse.usage.output_tokens
    console.log(`[Sync] Style guide extracted (${styleTokens} tokens used for extraction)`)

    // Step 3: Store the compact style guide as a single chunk (replaces all raw pairs)
    const guideResult = await storeChunkWithEmbedding(db, anthropic, {
      source: 'STYLE_GUIDE',
      sourceId: 'om_style_guide',
      title: "Om's Communication Style Guide",
      content: styleGuide,
      metadata: {
        pairsAnalyzed: pairs.length,
        extractedAt: new Date().toISOString(),
        extractionTokens: styleTokens,
      },
    })
    if (guideResult.action === 'created') itemsNew++
    else itemsUpdated++

    // Step 4: Also store raw pairs for dashboard display (but NOT sent to Claude per-message)
    for (const pair of pairs) {
      const content = `Buyer: "${pair.buyerMessage}"\nOm's reply: "${pair.omReply}"`
      const sourceId = `style_${Buffer.from(pair.buyerMessage.substring(0, 50) + pair.omReply.substring(0, 50)).toString('base64').substring(0, 40)}`

      const result = await storeChunkWithEmbedding(db, anthropic, {
        source: 'STYLE_PAIR',
        sourceId,
        title: `Style: "${pair.buyerMessage.substring(0, 60)}"`,
        content,
        metadata: {
          buyerMessage: pair.buyerMessage,
          omReply: pair.omReply,
          timestamp: pair.timestamp,
        },
      })
      if (result.action === 'created') itemsNew++
      else itemsUpdated++
    }

    await db.syncLog.create({
      data: {
        syncType: 'style_pairs',
        status: 'success',
        itemsFound,
        itemsNew,
        itemsUpdated,
        durationMs: Date.now() - startTime,
      },
    })

    console.log(`[Sync] Style pairs: ${itemsFound} pairs → 1 style guide + ${pairs.length} raw pairs stored`)
    return { status: 'success', itemsFound, itemsNew, itemsUpdated, styleGuideExtracted: true }

  } catch (err) {
    await db.syncLog.create({
      data: {
        syncType: 'style_pairs',
        status: 'failed',
        error: err.message,
        durationMs: Date.now() - startTime,
      },
    })
    console.error('[Sync] Style pairs failed:', err.message)
    throw err
  }
}

// ===========================================
// Helpers
// ===========================================

function buildProductDescription(product, catalogData) {
  const lines = []
  lines.push(`Product: ${product.name}`)
  if (product.description) lines.push(`Description: ${product.description}`)
  if (product.gsm) lines.push(`GSM (fabric weight): ${product.gsm}`)
  // PRICE (2026-08-18 fix): the LIVE products.json this now syncs from uses bulkPriceFrom/To +
  // per-size priceBands, NOT the repo copy's flat bulkPrice/samplePrice. Reading only the old
  // fields silently dropped the price line from 17 of 22 products for five days — the clone then
  // had NO authoritative price and invented one ("240gsm ₹185", which is the 210gsm rate).
  // Handle the live schema first, keep the legacy fields as a fallback, and expose the size bands
  // so a size-dependent product (e.g. True Bio 36–42 vs 44–46) is quoted correctly.
  const bFrom = product.bulkPriceFrom ?? product.bulkPrice
  const bTo = product.bulkPriceTo ?? product.bulkPrice
  if (bFrom) lines.push(`Bulk price (10+ pcs): ${bTo && bTo !== bFrom ? `₹${bFrom}–₹${bTo}` : `₹${bFrom}`} per piece`)
  const sFrom = product.samplePriceFrom ?? product.samplePrice
  const sTo = product.samplePriceTo ?? product.samplePrice
  if (sFrom) lines.push(`Sample price (under 10 pcs): ${sTo && sTo !== sFrom ? `₹${sFrom}–₹${sTo}` : `₹${sFrom}`} per piece`)
  // Size bands only when they actually differ — otherwise it is noise in every prompt.
  const bands = []
  for (const rate of (product.rates || [])) {
    for (const b of (rate.priceBands || [])) {
      if (b?.sizes && b?.price) bands.push(`${b.sizes} ₹${b.price}`)
    }
  }
  const uniqueBands = [...new Set(bands)]
  if (uniqueBands.length > 1) lines.push(`Size-wise bulk rates: ${uniqueBands.join(', ')} — quote the band matching the size the buyer asked for`)
  if (product.colors?.length) lines.push(`Available colors: ${product.colors.join(', ')}`)
  if (product.sizes?.length) lines.push(`Available sizes: ${product.sizes.join(', ')}`)
  if (product.weightKg) lines.push(`Weight: ${product.weightKg} kg`)
  if (catalogData.moq) lines.push(`Minimum order quantity (MOQ): ${catalogData.moq} pieces total (any mix of colors, sizes, or products for bulk rates). Less than ${catalogData.moq} pieces available at sample prices.`)
  if (catalogData.websiteDiscount) lines.push(`Extra ₹${catalogData.websiteDiscount} discount when ordering from website`)
  lines.push(`Order at: sale91.com/catalog`)
  return lines.join('\n')
}

function buildPoliciesChunk(catalogData) {
  const lines = []
  lines.push(`Business: BulkPlainTshirt.com / sale91.com — Wholesale blank apparel supplier in India`)
  if (catalogData.moq) lines.push(`Minimum Order Quantity (MOQ): ${catalogData.moq} pieces total — any mix of colors, sizes, or products. Below ${catalogData.moq} pieces, you can still order at sample prices (slightly higher per piece).`)
  if (catalogData.gstRate) lines.push(`GST: ${catalogData.gstRate}% (included in price)`)
  if (catalogData.paymentTerms) lines.push(`Payment terms: ${catalogData.paymentTerms}`)
  if (catalogData.websiteDiscount) lines.push(`Website discount: Extra ₹${catalogData.websiteDiscount}/pc off when ordering from sale91.com`)
  lines.push(`Catalog: sale91.com/catalog`)
  if (catalogData.contact) {
    if (catalogData.contact.whatsapp) lines.push(`WhatsApp: ${catalogData.contact.whatsapp}`)
    if (catalogData.contact.phone) lines.push(`Phone: ${catalogData.contact.phone}`)
  }
  lines.push(`Delivery: Pan India delivery available`)
  lines.push(`Samples: Buyers can order samples from the website before placing bulk orders`)
  return lines.join('\n')
}

function parseLlmsTxt(content) {
  // Parse llms.txt format into sections
  const sections = []
  const lines = content.split('\n')
  let currentSection = null
  let sectionContent = []
  let sectionId = 0

  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('# ')) {
      if (currentSection) {
        sections.push({
          id: String(sectionId++),
          title: currentSection,
          content: sectionContent.join('\n').trim(),
        })
      }
      currentSection = line.replace(/^#+\s*/, '')
      sectionContent = []
    } else if (currentSection) {
      sectionContent.push(line)
    }
  }

  if (currentSection) {
    sections.push({
      id: String(sectionId),
      title: currentSection,
      content: sectionContent.join('\n').trim(),
    })
  }

  return sections.filter(s => s.content.length > 20) // Skip tiny sections
}
