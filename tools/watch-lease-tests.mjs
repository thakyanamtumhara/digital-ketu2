import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const directory = mkdtempSync(join(tmpdir(), 'dk2-lease-test-'))
process.env.DK2_WATCH_STATE = directory
const { acquireLock, writeJson, readJson } = await import('./watch-common.mjs')
let child
try {
  const release = acquireLock('writer')
  assert(release)
  assert.equal(acquireLock('writer'), null)
  release()
  child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
  const exited = once(child, 'exit')
  const orphan = acquireLock('writer')
  orphan.setChildGroup(child.pid)
  orphan()
  assert(existsSync(join(directory, 'writer.lock')))
  const owner = readJson(join(directory, 'writer.lock/owner.json'))
  writeJson(join(directory, 'writer.lock/owner.json'), { ...owner, pid: 2147483647 })
  assert.equal(acquireLock('writer'), null)
  process.kill(-child.pid, 'SIGKILL')
  await exited
  const next = acquireLock('writer')
  assert(next)
  next()
  assert(!existsSync(join(directory, 'writer.lock')))
  console.log('6 writer lease checks passed, including surviving child process after parent death')
} finally {
  try { if (child?.pid) process.kill(-child.pid, 'SIGKILL') } catch {}
  rmSync(directory, { recursive: true, force: true })
}
