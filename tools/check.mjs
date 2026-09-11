import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
let failed = 0
for (const file of readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('-tests.mjs')).sort()) {
  const args = file === 'reply-flow-tests.mjs' ? ['--experimental-vm-modules', `tools/${file}`] : [`tools/${file}`]
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 60000 })
  if (result.status !== 0) { failed++; console.error(`FAIL ${file}\n${result.stdout}\n${result.stderr}`) }
  else console.log(`PASS ${file}`)
}
process.exitCode = failed ? 1 : 0
