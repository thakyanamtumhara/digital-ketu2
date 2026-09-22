export async function loadImageBatch({ messages, imageUrl, imageBlock, fetchImageBlock, downloadMedia }) {
  if (messages.length > 4) return { blocks: [], reason: 'image_batch_limit' }
  const primary = messages.find(message => message.mediaUrl) || messages.find(message => message.wwbunMessageId)
  const blocks = []
  for (const message of messages) {
    let block
    if (message === primary && imageUrl) block = imageBlock
    else {
      const url = message.mediaUrl || (message.wwbunMessageId ? await downloadMedia(message.wwbunMessageId) : null)
      block = url ? await fetchImageBlock(url) : null
    }
    if (!block) return { blocks: [], reason: 'image_batch_incomplete' }
    blocks.push(block)
  }
  return { blocks, reason: null }
}
