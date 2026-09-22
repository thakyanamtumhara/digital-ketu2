import assert from 'node:assert/strict'
import { loadImageBatch } from '../server/image-batch.js'

let checks = 0
async function test(name, fn) {
  await fn()
  checks++
  console.log('PASS ' + name)
}
const block = url => ({ type: 'image', source: { data: url } })

await test('later downloaded primary keeps original source order', async () => {
  const fetched = [], downloaded = []
  const result = await loadImageBatch({
    messages: [{ wwbunMessageId: 'pending' }, { mediaUrl: 'ready' }],
    imageUrl: 'ready', imageBlock: block('ready'),
    downloadMedia: async id => { downloaded.push(id); return 'resolved' },
    fetchImageBlock: async url => { fetched.push(url); return block(url) },
  })
  assert.deepEqual(result.blocks.map(item => item.source.data), ['resolved', 'ready'])
  assert.deepEqual(downloaded, ['pending'])
  assert.deepEqual(fetched, ['resolved'])
})
await test('first on-demand primary is reused without duplicate fetch', async () => {
  const downloaded = []
  const result = await loadImageBatch({
    messages: [{ wwbunMessageId: 'first' }, { wwbunMessageId: 'second' }],
    imageUrl: 'resolved-first', imageBlock: block('resolved-first'),
    downloadMedia: async id => { downloaded.push(id); return id },
    fetchImageBlock: async url => block(url),
  })
  assert.deepEqual(result.blocks.map(item => item.source.data), ['resolved-first', 'second'])
  assert.deepEqual(downloaded, ['second'])
})
await test('missing download discards the entire incomplete batch', async () => {
  const result = await loadImageBatch({
    messages: [{ mediaUrl: 'first' }, { wwbunMessageId: 'missing' }],
    imageUrl: 'first', imageBlock: block('first'),
    downloadMedia: async () => null, fetchImageBlock: async () => assert.fail('no unresolved fetch'),
  })
  assert.deepEqual(result, { blocks: [], reason: 'image_batch_incomplete' })
})
await test('oversized batch does not fetch or silently truncate', async () => {
  const result = await loadImageBatch({
    messages: Array.from({ length: 5 }, () => ({ mediaUrl: 'photo' })),
    fetchImageBlock: async () => assert.fail('no fetch'), downloadMedia: async () => assert.fail('no download'),
  })
  assert.deepEqual(result, { blocks: [], reason: 'image_batch_limit' })
})
console.log(`${checks}/${checks} image batch checks passed`)
