// THE WATCH LOOP, IN ONE COMMAND.
//
// Ketu's rule: "If I had to reply manually, the AI failed." This pulls recent traffic and finds
// every paid AI reply that Ketu followed up on by hand within 3h — that pairing IS the miss signal.
// Everything else in the audit (classify, verify, fix) hangs off this list.
//
//   node tools/audit-interventions.mjs [days]        # default 3
//
// Needs ~/.dk2_read_token. Writes interventions.json next to itself for downstream tooling.

import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const DAYS = Number(process.argv[2] || 3)
const BASE = 'https://digital-ketu2-production.up.railway.app'
const TOKEN = readFileSync(join(homedir(), '.dk2_read_token'), 'utf8').trim()

const pages = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    fetch(`${BASE}/api/logs?limit=300&offset=${i * 300}`, { headers: { 'X-DK-Read-Token': TOKEN } })
      .then(r => r.json()).catch(() => [])
  )
)

const rows = new Map()
for (const p of pages) if (Array.isArray(p)) for (const r of p) if (r && r.id) rows.set(r.id, r)

const cutoff = Date.now() - DAYS * 86400000
const all = [...rows.values()]
  .filter(r => new Date(r.createdAt).getTime() >= cutoff)
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

const convOf = r => (r.conversation || {}).id || (r.conversation || {}).whatsappNumber
const numOf = r => (r.conversation || {}).whatsappNumber || '?'
const byConv = new Map()
for (const r of all) {
  if (!byConv.has(convOf(r))) byConv.set(convOf(r), [])
  byConv.get(convOf(r)).push(r)
}

const paid = all.filter(r => r.status === 'REPLIED')
const ivs = []
for (const seq of byConv.values()) {
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].status !== 'REPLIED') continue
    for (const nx of seq.slice(i + 1)) {
      const mins = (new Date(nx.createdAt) - new Date(seq[i].createdAt)) / 60000
      if (mins > 180) break
      // Ketu typing by hand after the clone already answered = the clone probably failed.
      if (nx.deferReason === 'manual_reply' && (nx.aiReply || '').trim()) {
        ivs.push({
          num: numOf(seq[i]), at: seq[i].createdAt.slice(5, 16), mins: Math.round(mins),
          buyer: (seq[i].buyerMessage || '').slice(0, 300),
          ai: (seq[i].aiReply || '').slice(0, 300),
          ketu: (nx.aiReply || '').slice(0, 300),
        })
        break
      }
    }
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), 'interventions.json')
writeFileSync(out, JSON.stringify(ivs, null, 1))

console.log(`window            : last ${DAYS} day(s), ${all.length} rows`)
console.log(`paid AI replies   : ${paid.length}`)
console.log(`Ketu had to type  : ${ivs.length}`)
console.log(`intervention rate : ${(100 * ivs.length / Math.max(1, paid.length)).toFixed(1)}%`)
console.log(`\nwrote ${out}`)
console.log('\nNOTE: raw rate OVERSTATES the problem — roughly half are Ketu saying "Ok" or handling')
console.log('something only he can (bank details, a dispute, a refund). Classify before acting.')
