const CATALOG_URL = process.env.LIVE_PRODUCTS_URL || 'https://www.bulkplaintshirt.com/catalog/products.json'

export const CATALOG_UNAVAILABLE = 'CURRENT CATALOG UNAVAILABLE — product facts could not be verified. Do not quote prices or infer them from previous messages, images or stored knowledge. For a product-fact question, offer https://sale91.com/catalog or [DEFER] if the buyer needs confirmation. Continue answering supported general questions normally.'

const HEADER = 'AUTHORITATIVE CATALOG — the COMPLETE, current product list. This is the ONLY source of product FACTS: every price, GSM, fabric, colour, size and link the buyer could ask about is here. If you state ANY price/gsm/colour/size, it MUST be copied EXACTLY from this list (never round, never guess, never use a number from memory or the chat). "bulk" = 10+ pcs, "sample" = under 10 pcs — counted on the buyer\'s TOTAL order across ALL products combined, NOT per product (a 3-pc line inside an 18-pc total order is still BULK rate). Each rate group applies ONLY to its listed colours and sizes. Old screenshots and previous quotes never override these rates. For a broad colour-family request, listed shades count: Navy, Royal Blue and Sky are blue choices, not evidence that blue is missing. Apply the listed product fit too; True Bio is within the regular-fit range. For an exact shade, use that shade only. A colour family with NO listed member, or an exact shade NOT listed, = we don\'t make it for that product (send HD Photos). A product NOT in this list = we don\'t make it. If a listed detail isn\'t shown, don\'t invent it. (The KNOWLEDGE BASE in the user message is only for STYLE/how-Ketu-phrases-it — NOT for facts.)'

function textList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(x => typeof x === 'string' && x.trim())
}

function validPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function buildCatalogFacts(data) {
  if (!Array.isArray(data?.categories) || !data.categories.length || data.categories.some(c => !Array.isArray(c.products))) throw Error('Invalid live catalog categories')
  const entries = data.categories.flatMap(c => c.products)
  if (!entries.length) throw Error('Empty live catalog')
  const slugs = new Set(), lines = [], products = []
  for (const p of entries) {
    if (!p || typeof p.name !== 'string' || !p.name.trim() || typeof p.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug) || slugs.has(p.slug)) throw Error('Invalid or duplicate live catalog product')
    slugs.add(p.slug)
    if (!textList(p.colors) || !textList(p.sizes) || !Array.isArray(p.rates) || !p.rates.length) throw Error('Missing live catalog rate groups')
    const parts = [p.name]
    if (validPrice(p.gsm)) parts.push(`${p.gsm}gsm`)
    if (typeof p.description === 'string') parts.push(p.description.replace(/\s*\([^)]*\)/g, '').replace(/Premium Quality.*$/i, '').trim())
    parts.push(`colours: ${p.colors.join('/')}`, `sizes: ${p.sizes.join('/')}`)
    const bulk = [], sample = [], seenColors = new Set()
    for (const rate of p.rates) {
      if (!textList(rate.colors) || !rate.pricePerSize || typeof rate.pricePerSize !== 'object' || Array.isArray(rate.pricePerSize) || !validPrice(rate.samplePrice)) throw Error('Invalid live catalog rates')
      for (const color of rate.colors) {
        if (!p.colors.includes(color) || seenColors.has(color)) throw Error('Ambiguous live catalog colour rates')
        seenColors.add(color)
      }
      const sizeRates = Object.entries(rate.pricePerSize)
      if (sizeRates.length !== p.sizes.length || p.sizes.some(size => !validPrice(rate.pricePerSize[size]))) throw Error('Incomplete live catalog size rates')
      const bands = new Map()
      for (const [size, price] of sizeRates) {
        if (!p.sizes.includes(size) || !validPrice(price)) throw Error('Invalid live catalog size rate')
        if (!bands.has(price)) bands.set(price, [])
        bands.get(price).push(size)
        bulk.push(price)
      }
      sample.push(rate.samplePrice)
      parts.push(`${rate.colors.join('/')}: bulk ${[...bands].map(([price, sizes]) => `${sizes.join('/')} ₹${price}`).join('; ')}; sample ₹${rate.samplePrice}`)
    }
    if (seenColors.size !== p.colors.length) throw Error('Incomplete live catalog colour rates')
    parts.push(`→ /catalog/p/${p.slug}`)
    lines.push(parts.join(' | '))
    const fit = /(?:^|[,;|])\s*regular[\s-]+fit(?=\s*(?:[,;|]|$))/i.test(p.description || '') ? 'regular' : null
    products.push({ title: p.name, gsm: Number(p.gsm) || null, fit, colors: [...p.colors], bulk: Math.min(...bulk), sample: Math.min(...sample), bulkRange: [Math.min(...bulk), Math.max(...bulk)], sampleRange: [Math.min(...sample), Math.max(...sample)], slug: p.slug })
  }
  return { block: HEADER + '\n' + lines.sort().join('\n'), products }
}

export function appendSaleCatalog(facts, table) {
  if (!Array.isArray(table) || !table[0] || typeof table[0] !== 'object' || !Object.keys(table[0]).length || !table[1] || !table[2]) throw Error('Invalid current ordering table')
  const lines = [], products = [...facts.products]
  for (const [name, colors] of Object.entries(table[0])) {
    if (!name.startsWith('Sale: ')) continue
    const parts = [name], prices = []
    if (!colors || typeof colors !== 'object' || !Object.keys(colors).length || !validPrice(table[2][name])) throw Error('Invalid sale product rates')
    const description = table[1][name]?.[1]
    if (typeof description === 'string') parts.push(description)
    for (const [color, sizes] of Object.entries(colors)) {
      if (!sizes || typeof sizes !== 'object' || !Object.keys(sizes).length || Object.values(sizes).some(p => !validPrice(p))) throw Error('Invalid sale size rates')
      parts.push(`${color}: bulk ${Object.entries(sizes).map(([size, price]) => `${size} ₹${price}`).join('; ')}; sample ₹${table[2][name]}`)
      prices.push(...Object.values(sizes))
    }
    parts.push('→ /catalog; availability only from LIVE STOCK DATA')
    lines.push(parts.join(' | '))
    products.push({ title: name, gsm: null, bulk: Math.min(...prices), sample: table[2][name], slug: null })
  }
  return { block: facts.block + (lines.length ? '\n' + lines.sort().join('\n') : ''), products }
}

export function appendOrderingFamilies(facts, data, table) {
  if (!Array.isArray(table) || !table[0] || !table[1] || !table[2]) return facts
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x))
  const description = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : ''
  const entries = data?.categories?.flatMap(c => c.products || []) || []
  const resolved = []
  for (const product of entries) {
    if (!facts.products.some(p => p.slug === product.slug) || !description(product.description) || !Array.isArray(product.rates)) continue
    const aliases = []
    let complete = true
    for (const rate of product.rates) {
      if (!Array.isArray(rate.colors) || !rate.pricePerSize) { complete = false; break }
      const matches = Object.entries(table[0]).filter(([name, colors]) => {
        const meta = table[1][name]
        if (!name || /[\r\n"<>]/.test(name) || name.startsWith('Sale: ') || !Array.isArray(meta) || !/^[a-z0-9]+(?:-\d+)?$/i.test(meta[0] || '')) return false
        if (description(meta[1]) !== description(product.description) || table[2][name] !== rate.samplePrice) return false
        if (!colors || typeof colors !== 'object' || !sameSet(Object.keys(colors), rate.colors)) return false
        return rate.colors.every(color => colors[color] && sameSet(Object.keys(colors[color]), Object.keys(rate.pricePerSize)) && Object.entries(rate.pricePerSize).every(([size, price]) => validPrice(price) && colors[color][size] === price))
      })
      if (matches.length !== 1) { complete = false; break }
      const name = matches[0][0]
      aliases.push({ name, colors: [...rate.colors], family: table[1][name][0].replace(/-\d+$/, '') })
    }
    if (!complete || aliases.length < 2 || new Set(aliases.map(a => a.name)).size !== aliases.length || new Set(aliases.map(a => a.family)).size !== 1) continue
    const colors = aliases.flatMap(a => a.colors)
    if (new Set(colors).size !== colors.length || !sameSet(colors, product.colors || [])) continue
    resolved.push({ slug: product.slug, title: product.name, aliases })
  }
  const unambiguous = resolved.filter(group => group.aliases.every(alias => resolved.filter(other => other.aliases.some(a => a.name === alias.name)).length === 1))
  if (!unambiguous.length) return facts
  const lines = unambiguous.map(group => `${group.aliases.map(a => `"${a.name}" (${a.colors.join('/')})`).join(' and ')} are colour-price groups of the SAME catalogue product and fit: ${group.title} → /catalog/p/${group.slug}. These bill/order names do not identify different fits. This verifies the name mapping only, not what was packed or any requested order change.`)
  return { ...facts, block: facts.block + '\nVERIFIED BILL/ORDER NAME MAPPING (current ordering table and catalogue agree on family, description, every colour/size price and sample price):\n' + lines.join('\n') }
}

export function canonicalizeCatalogLinks(reply, products) {
  const current = new Set(products.map(p => p.slug).filter(Boolean))
  const replacements = { 'hoodie-320gsm-black': 'hoodie-320gsm', 'dropshoulder-hoodie-430gsm': 'hoodie-430gsm' }
  return String(reply).replace(/(https:\/\/(?:www\.)?(?:sale91\.com|bulkplaintshirt\.com)\/catalog\/p\/)([a-z0-9-]+)(?=[/?#\s),.!]|$)/gi, (url, prefix, slug) => {
    const replacement = replacements[slug.toLowerCase()]
    return replacement && current.has(replacement) ? prefix + replacement : url
  })
}

export function createCatalogLoader({ fetcher = fetch, now = Date.now, ttlMs = 5 * 60 * 1000, url = CATALOG_URL } = {}) {
  let cached = null, fetchedAt = 0, pending = null
  return async () => {
    if (cached && now() - fetchedAt < ttlMs) return cached
    if (pending) return pending
    pending = (async () => {
      const source = new URL(url)
      if (source.protocol !== 'https:' || source.username || source.password) throw Error('Invalid catalog source')
      source.searchParams.set('dk2', String(Math.floor(now() / ttlMs)))
      const response = await fetcher(source.href, { signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw Error(`Live catalog HTTP ${response.status}`)
      const data = await response.json()
      const mainFacts = buildCatalogFacts(data)
      const ordering = await fetcher(`https://www.bulkplaintshirt.com/pc.js?dk2=${Math.floor(now() / ttlMs)}`, { signal: AbortSignal.timeout(10000) })
      if (!ordering.ok) throw Error(`Ordering table HTTP ${ordering.status}`)
      const text = await ordering.text()
      if (text.indexOf('=') < 0) throw Error('Invalid ordering table assignment')
      const table = JSON.parse(text.slice(text.indexOf('=') + 1).replace(/;\s*$/, ''))
      const facts = appendSaleCatalog(appendOrderingFamilies(mainFacts, data, table), table)
      cached = facts
      fetchedAt = now()
      return facts
    })()
    try { return await pending } finally { pending = null }
  }
}

export const getCatalogFacts = createCatalogLoader()
