import assert from 'node:assert/strict'
import { buildCatalogFacts, createCatalogLoader, appendSaleCatalog, appendOrderingFamilies, canonicalizeCatalogLinks } from '../server/catalog-facts.js'

const product = {
  name: 'Example Hoodie', slug: 'example-hoodie', gsm: 320,
  colors: ['Black', 'White'], sizes: ['M', 'XXL'],
  bulkPriceFrom: 99, samplePriceFrom: 101,
  rates: [
    { colors: ['Black'], pricePerSize: { M: 211, XXL: 223 }, samplePrice: 277 },
    { colors: ['White'], pricePerSize: { M: 239, XXL: 251 }, samplePrice: 299 },
  ],
}
const fixture = () => ({ categories: [{ products: [structuredClone(product)] }] })
const facts = buildCatalogFacts(fixture())
assert.match(facts.block, /Black: bulk M ₹211; XXL ₹223; sample ₹277/)
assert.match(facts.block, /White: bulk M ₹239; XXL ₹251; sample ₹299/)
assert.doesNotMatch(facts.block, /₹99\b|₹101\b/)
assert.equal(facts.products[0].bulk, 211)
assert.deepEqual(facts.products[0].bulkRange, [211, 251])
assert.deepEqual(facts.products[0].sampleRange, [277, 299])
assert.equal(facts.products[0].slug, 'example-hoodie')
assert.equal(facts.products[0].fit, null)
assert.deepEqual(facts.products[0].colors, ['Black', 'White'])
for (const [description, expected] of [
  ['Regular Fit, True Biowash Round neck, 180gsm', 'regular'],
  ['Regular-fit; 100% cotton', 'regular'],
  ['Not regular fit, oversized', null],
  ['Oversized fit', null],
  ['', null],
]) {
  const data = fixture()
  data.categories[0].products[0].description = description
  assert.equal(buildCatalogFacts(data).products[0].fit, expected)
}

for (const mutate of [
  d => { d.categories = [] },
  d => { d.categories[0].products = [] },
  d => { d.categories[0].products.push(structuredClone(product)) },
  d => { d.categories[0].products[0].rates[0].pricePerSize.M = 0 },
  d => { delete d.categories[0].products[0].rates[0].pricePerSize.XXL },
  d => { d.categories[0].products[0].rates[1].colors = ['Black'] },
  d => { d.categories[0].products[0].rates.pop() },
  d => { d.categories[0].products[0].rates[0].samplePrice = null },
]) {
  const data = fixture()
  mutate(data)
  assert.throws(() => buildCatalogFacts(data))
}

let clock = 1000, calls = 0, fail = false, current = fixture()
const get = createCatalogLoader({ ttlMs: 100, now: () => clock, fetcher: async url => {
  calls++
  assert.equal(new URL(url).searchParams.get('dk2'), String(Math.floor(clock / 100)))
  if (fail) throw Error('offline')
  if (new URL(url).pathname === '/pc.js') return { ok: true, text: async () => 'let tbl=[{"Sale: Example":{"Green":{"22":63}}},{"Sale: Example":["Example","Sale product"]},{"Sale: Example":91}]' }
  return { ok: true, json: async () => current }
} })
await Promise.all([get(), get(), get()])
assert.equal(calls, 2)
clock += 99
await get()
assert.equal(calls, 2)
clock += 1
fail = true
await assert.rejects(get(), /offline/)
await assert.rejects(get(), /offline/)
fail = false
current.categories[0].products[0].rates[0].pricePerSize.M = 217
assert.match((await get()).block, /M ₹217/)
assert.equal(calls, 6)
clock += 100
current = { categories: [] }
await assert.rejects(get(), /Invalid live catalog/)
console.log('PASS catalogue colour/size bands, invalid/partial source rejection, cache sharing, expiry and recovery')

const extra = appendSaleCatalog(facts, [{ 'Sale: Example': { Green: { '22': 63 } } }, { 'Sale: Example': ['Example', 'Remaining pieces'] }, { 'Sale: Example': 91 }])
assert.match(extra.block, /Sale: Example.*Green: bulk 22 ₹63; sample ₹91/)
assert.equal(extra.products.length, 2)
assert.throws(() => appendSaleCatalog(facts, []))
const products = [{ slug: 'hoodie-320gsm' }, { slug: 'hoodie-430gsm' }]
assert.equal(canonicalizeCatalogLinks('https://sale91.com/catalog/p/hoodie-320gsm-black?x=1', products), 'https://sale91.com/catalog/p/hoodie-320gsm?x=1')
assert.equal(canonicalizeCatalogLinks('https://www.bulkplaintshirt.com/catalog/p/dropshoulder-hoodie-430gsm/', products), 'https://www.bulkplaintshirt.com/catalog/p/hoodie-430gsm/')
for (const url of ['https://sale91.com/catalog/p/zip-hoodie', 'https://external.invalid/catalog/p/hoodie-320gsm-black', 'https://sale91.com/catalog/p/hoodie-320gsm-black-other']) assert.equal(canonicalizeCatalogLinks(url, products), url)
assert.equal(canonicalizeCatalogLinks('https://sale91.com/catalog/p/hoodie-320gsm-black', []), 'https://sale91.com/catalog/p/hoodie-320gsm-black')
console.log('PASS current sale prices and scoped retired-link redirects')

const familyData = fixture()
familyData.categories[0].products[0].description = 'Dropshoulder hoodie, cotton blend'
const familyFacts = buildCatalogFacts(familyData)
const familyTable = [
  { 'Drop Hoodie': { Black: { M: 211, XXL: 223 } }, 'Hoodie-2': { White: { M: 239, XXL: 251 } } },
  { 'Drop Hoodie': ['HoodExample', 'Dropshoulder hoodie, cotton blend'], 'Hoodie-2': ['HoodExample-2', 'Dropshoulder hoodie, cotton blend'] },
  { 'Drop Hoodie': 277, 'Hoodie-2': 299 },
]
const mapped = appendOrderingFamilies(familyFacts, familyData, familyTable)
assert.match(mapped.block, /"Drop Hoodie" \(Black\) and "Hoodie-2" \(White\).*SAME catalogue product and fit: Example Hoodie/)
assert.match(mapped.block, /name mapping only, not what was packed or any requested order change/)
assert.equal(mapped.products, familyFacts.products)
assert.doesNotMatch(familyFacts.block, /VERIFIED BILL/)
for (const mutate of [
  t => { t[0]['Hoodie-2'].White.M++ },
  t => { delete t[0]['Hoodie-2'].White.XXL },
  t => { t[0]['Hoodie-2'].White.S = 239 },
  t => { t[0]['Hoodie-2'].Navy = { M: 239, XXL: 251 } },
  t => { t[1]['Hoodie-2'][0] = 'DifferentFamily-2' },
  t => { t[1]['Hoodie-2'][1] = 'Regular fit hoodie, cotton blend' },
  t => { t[1]['Hoodie-2'][1] = '' },
  t => { t[2]['Hoodie-2']++ },
  t => { delete t[0]['Hoodie-2'] },
  t => { t[0]['Duplicate'] = structuredClone(t[0]['Hoodie-2']); t[1].Duplicate = [...t[1]['Hoodie-2']]; t[2].Duplicate = t[2]['Hoodie-2'] },
]) {
  const table = structuredClone(familyTable)
  mutate(table)
  assert.equal(appendOrderingFamilies(familyFacts, familyData, table).block, familyFacts.block)
}
const ambiguousData = structuredClone(familyData)
ambiguousData.categories[0].products.push({ ...structuredClone(ambiguousData.categories[0].products[0]), name: 'Another Hoodie', slug: 'another-hoodie' })
const ambiguousFacts = buildCatalogFacts(ambiguousData)
assert.equal(appendOrderingFamilies(ambiguousFacts, ambiguousData, familyTable).block, ambiguousFacts.block)
assert.equal(appendOrderingFamilies(familyFacts, familyData, []).block, familyFacts.block)
const single = structuredClone(familyData)
single.categories[0].products[0].colors = ['Black']
single.categories[0].products[0].rates.pop()
const singleFacts = buildCatalogFacts(single)
assert.equal(appendOrderingFamilies(singleFacts, single, familyTable).block, singleFacts.block)
const loadedFamily = createCatalogLoader({ fetcher: async url => new URL(url).pathname === '/pc.js'
  ? { ok: true, text: async () => 'let tbl=' + JSON.stringify(familyTable) }
  : { ok: true, json: async () => familyData } })
assert.match((await loadedFamily()).block, /VERIFIED BILL\/ORDER NAME MAPPING/)
console.log('PASS bill name family joins, all-rate matching, genuine different fits, ambiguous and changing source controls')
