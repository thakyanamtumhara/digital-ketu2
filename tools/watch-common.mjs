import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const stateDir = process.env.DK2_WATCH_STATE || join(homedir(), '.local/state/dk2-watch')
export function readJson(file, fallback = {}) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}
export function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, file)
}
export function config() {
  return {
    repository: join(homedir(), 'Projects/digital-ketu2'),
    memoryRoot: join(homedir(), 'Projects/ai-memory'),
    dk2Base: 'https://digital-ketu2-production.up.railway.app',
    inboxBase: 'https://mm.sale91.com',
    readTokenFile: join(homedir(), '.dk2_read_token'),
    bridgeEnvFile: join(homedir(), 'Projects/wwbun/owner-runner/.env'),
    ghCommand: '/opt/homebrew/bin/gh',
    ...readJson(join(stateDir, 'config.json')),
  }
}
export function acquireLock(name) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const directory = join(stateDir, name + '.lock')
  const identity = randomUUID()
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = readJson(join(directory, 'owner.json'), null)
    if (!owner && Date.now() - statSync(directory).mtimeMs < 300000) return null
    if (owner) {
      if (owner.childGroupId) {
        try { process.kill(-owner.childGroupId, 0); return null } catch (error) {
          if (error.code !== 'ESRCH') return null
        }
      }
      try { process.kill(owner.pid, 0); return null } catch (error) {
        if (error.code !== 'ESRCH') return null
      }
    }
    const retired = `${directory}.stale.${randomUUID()}`
    try { renameSync(directory, retired) } catch { return null }
    rmSync(retired, { recursive: true, force: true })
    try { mkdirSync(directory, { mode: 0o700 }) } catch { return null }
  }
  writeJson(join(directory, 'owner.json'), { pid: process.pid, identity, startedAt: new Date().toISOString() })
  const release = () => {
    const owner = readJson(join(directory, 'owner.json'), {})
    if (owner.identity !== identity) return
    if (owner.childGroupId) {
      try { process.kill(-owner.childGroupId, 0); return } catch (error) {
        if (error.code !== 'ESRCH') return
      }
    }
    rmSync(directory, { recursive: true, force: true })
  }
  release.setChildGroup = childGroupId => {
    const owner = readJson(join(directory, 'owner.json'), {})
    if (owner.identity !== identity) throw new Error('Writer lease ownership changed')
    writeJson(join(directory, 'owner.json'), { ...owner, childGroupId })
  }
  return release
}
export function credentials(c) {
  const env = readFileSync(c.bridgeEnvFile, 'utf8')
  const match = env.match(/^DIGITAL_KETU_SECRET\s*=\s*(.*)$/m)
  const secret = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
  const token = readFileSync(c.readTokenFile, 'utf8').trim()
  if (!secret || !token) throw new Error('Watch credentials missing')
  return { token, secret }
}
export async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(25000) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`)
  return response.json()
}
export async function fetchLogs(c, token, since, until = new Date().toISOString()) {
  const rows = new Map()
  for (let offset = 0; offset < 20000; offset += 200) {
    const url = `${c.dk2Base}/api/logs?lite=1&limit=200&offset=${offset}&since=${encodeURIComponent(since)}`
    const page = await getJson(url, { 'X-DK-Read-Token': token })
    if (!Array.isArray(page)) throw new Error('Logs response is not an array')
    for (const row of page) if (row.id && row.createdAt <= until) rows.set(row.id, row)
    if (page.length < 200) return [...rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  throw new Error('Logs page cap reached; cursor retained for a complete retry')
}
export function notifyOwner(c, title, message) {
  const env = { ...process.env }
  const auth = spawnSync(c.ghCommand, ['auth', 'token', '--user', 'thakyanamtumhara'], { encoding: 'utf8', timeout: 15000 })
  if (auth.status !== 0 || !auth.stdout.trim()) throw new Error('Telegram GitHub credentials unavailable')
  env.GH_TOKEN = auth.stdout.trim()
  const result = spawnSync(c.ghCommand, ['workflow', 'run', 'notify-telegram.yml', '-R', 'thakyanamtumhara/Website-Order-Dashboard', '-f', `title=${title}`, '-f', `message=${message}`], { env, encoding: 'utf8', timeout: 25000 })
  if (result.status !== 0) throw new Error('Telegram workflow dispatch failed')
}
export function syncMemory(c) {
  if (!Array.isArray(c.syncCommand) || !c.syncCommand.length) return { configured: false }
  const [command, ...args] = c.syncCommand
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, cwd: c.memoryRoot })
  return { configured: true, ok: result.status === 0, at: new Date().toISOString() }
}
export function paused() { return existsSync(join(stateDir, 'PAUSE')) }
