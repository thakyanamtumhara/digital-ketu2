// Sync module — pulls data from GitHub repos and builds knowledge base
// 1. Saved Replies from wwbun repo (Prisma schema → ReplyTemplate model)
// 2. Product Catalog from catalog repo (products.json)

import { storeChunkWithEmbedding } from './embeddings.js'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_REPO_WWBUN = process.env.GITHUB_REPO_WWBUN || 'thakyanamtumhara/wwbun'
const GITHUB_REPO_CATALOG = process.env.GITHUB_REPO_CATALOG || 'thakyanamtumhara/catalog'

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
      // Fetch templates from wwbun API
      const response = await fetch(`${WWBUN_API_URL}/api/templates`, {
        headers: {
          'X-Digital-Ketu-Secret': DIGITAL_KETU_SECRET,
        },
      })
      if (response.ok) {
        templates = await response.json()
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
      // Process wwbun templates
      itemsFound = templates.length
      for (const template of templates) {
        const content = template.content || ''
        const shortcut = template.shortcut || ''
        const title = shortcut ? `/${shortcut}` : `Template ${template.id}`

        const result = await storeChunkWithEmbedding(db, anthropic, {
          source: 'SAVED_REPLY',
          sourceId: `template_${template.id}`,
          title,
          content,
          metadata: {
            shortcut,
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
    // Fetch products.json from catalog repo
    const rawJson = await fetchGitHubFile(GITHUB_REPO_CATALOG, 'products.json')
    const catalogData = JSON.parse(rawJson)
    const products = catalogData.products || []

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
          bulkPrice: product.bulkPrice,
          samplePrice: product.samplePrice,
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
// Helpers
// ===========================================

function buildProductDescription(product, catalogData) {
  const lines = []
  lines.push(`Product: ${product.name}`)
  if (product.description) lines.push(`Description: ${product.description}`)
  if (product.gsm) lines.push(`GSM (fabric weight): ${product.gsm}`)
  if (product.bulkPrice) lines.push(`Bulk price: ₹${product.bulkPrice} per piece`)
  if (product.samplePrice) lines.push(`Sample price: ₹${product.samplePrice} per piece`)
  if (product.colors?.length) lines.push(`Available colors: ${product.colors.join(', ')}`)
  if (product.sizes?.length) lines.push(`Available sizes: ${product.sizes.join(', ')}`)
  if (product.weightKg) lines.push(`Weight: ${product.weightKg} kg`)
  if (catalogData.moq) lines.push(`Minimum order quantity (MOQ): ${catalogData.moq} pieces`)
  if (catalogData.websiteDiscount) lines.push(`Extra ₹${catalogData.websiteDiscount} discount when ordering from website`)
  lines.push(`Order at: sale91.com/catalog`)
  return lines.join('\n')
}

function buildPoliciesChunk(catalogData) {
  const lines = []
  lines.push(`Business: BulkPlainTshirt.com / sale91.com — Wholesale blank apparel supplier in India`)
  if (catalogData.moq) lines.push(`Minimum Order Quantity (MOQ): ${catalogData.moq} pieces per color per size`)
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
