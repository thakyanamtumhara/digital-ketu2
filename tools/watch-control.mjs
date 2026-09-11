import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { config, stateDir, readJson, writeJson } from './watch-common.mjs'

const action = process.argv[2] || 'status'
const domain = `gui/${process.getuid()}`
const launchDir = join(homedir(), 'Library/LaunchAgents')
const labels = ['com.ketu.dk2pulse', 'com.ketu.dk2review']
const pauseFile = join(stateDir, 'PAUSE')
const backupDir = join(stateDir, 'undo')
const xml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 20000 })
function plist(label, script, schedule) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string></array>
<key>WorkingDirectory</key><string>${xml(config().repository)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/ankit/.npm-global/bin</string><key>TZ</key><string>Asia/Kolkata</string></dict>
<key>ProcessType</key><string>Background</string>
${schedule}
<key>StandardOutPath</key><string>${xml(join(stateDir, label + '.out.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(stateDir, label + '.err.log'))}</string>
</dict></plist>\n`
}
mkdirSync(stateDir, { recursive: true, mode: 0o700 })
if (action === 'pause') {
  writeFileSync(pauseFile, new Date().toISOString() + '\n', { mode: 0o600 })
  console.log('Paused. The running review is interrupted within 5 seconds; wait for writer.lock to clear before editing production.')
} else if (action === 'resume') {
  if (existsSync(pauseFile)) unlinkSync(pauseFile)
  console.log('Review resumed for the next scheduled tick.')
} else if (action === 'install') {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const undoManifest = join(backupDir, 'manifest.json')
  if (!existsSync(undoManifest)) {
    const prior = [...labels, 'com.ketu.dk2watch'].map(label => {
      const file = join(launchDir, label + '.plist')
      if (existsSync(file)) copyFileSync(file, join(backupDir, label + '.plist'))
      return { label, existed: existsSync(file), loaded: run('launchctl', ['print', `${domain}/${label}`]).status === 0 }
    })
    writeJson(undoManifest, { at: new Date().toISOString(), agents: prior })
    for (const entry of prior.filter(x => x.existed)) {
      if (run('plutil', ['-lint', join(backupDir, entry.label + '.plist')]).status !== 0) throw new Error('Undo plist failed validation')
      if (!readFileSync(join(backupDir, entry.label + '.plist')).equals(readFileSync(join(launchDir, entry.label + '.plist')))) throw new Error('Undo plist differs from original')
    }
  }
  if (!existsSync(join(stateDir, 'config.json'))) {
    writeJson(join(stateDir, 'config.json'), { reviewCommand: [join(homedir(), '.npm-global/bin/codex'), 'exec', '--json', '--cd', '{workspace}', '--output-last-message', '{report}', '-'], reviewTimeoutMinutes: 90 })
  }
  const toolsDir = fileURLToPath(new URL('.', import.meta.url))
  const schedules = [
    '<key>StartInterval</key><integer>1800</integer><key>RunAtLoad</key><true/>',
    `<key>StartCalendarInterval</key><array>${[9, 11, 13, 15, 17, 19, 21, 23].map(hour => `<dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>13</integer></dict>`).join('')}</array>`,
  ]
  for (let i = 0; i < labels.length; i++) {
    const file = join(launchDir, labels[i] + '.plist')
    const script = join(toolsDir, i === 0 ? 'watch-pulse.mjs' : 'watch-review.mjs')
    const newPlist = file + '.pending'
    writeFileSync(newPlist, plist(labels[i], script, schedules[i]), { mode: 0o600 })
    if (run('plutil', ['-lint', newPlist]).status !== 0) throw new Error('Generated LaunchAgent failed validation')
    run('launchctl', ['bootout', `${domain}/${labels[i]}`])
    copyFileSync(newPlist, file)
    unlinkSync(newPlist)
    const result = run('launchctl', ['bootstrap', domain, file])
    if (result.status !== 0) throw new Error(`LaunchAgent ${labels[i]} failed to load`)
  }
  console.log('Pulse and review LaunchAgents loaded. Existing review pause retained. Old log-only watcher remains until retire-old.')
} else if (action === 'retire-old') {
  if (!existsSync(join(backupDir, 'com.ketu.dk2watch.plist'))) throw new Error('Old watcher rollback backup missing')
  run('launchctl', ['bootout', `${domain}/com.ketu.dk2watch`])
  const file = join(launchDir, 'com.ketu.dk2watch.plist')
  if (existsSync(file)) unlinkSync(file)
  console.log('Old log-only watcher retired; undo is retained.')
} else if (action === 'uninstall') {
  const manifest = readJson(join(backupDir, 'manifest.json'), null)
  if (!manifest) throw new Error('No undo manifest')
  for (const entry of manifest.agents) {
    run('launchctl', ['bootout', `${domain}/${entry.label}`])
    const file = join(launchDir, entry.label + '.plist')
    if (entry.existed) copyFileSync(join(backupDir, entry.label + '.plist'), file)
    else if (existsSync(file)) unlinkSync(file)
    if (entry.loaded && run('launchctl', ['bootstrap', domain, file]).status !== 0) throw new Error(`Could not restore ${entry.label}`)
  }
  console.log('Prior LaunchAgents restored from the validated undo.')
} else if (action === 'status') {
  console.log(JSON.stringify({ paused: existsSync(pauseFile), writer: readJson(join(stateDir, 'writer.lock/owner.json'), null), pulse: readJson(join(stateDir, 'pulse-state.json'), null), review: readJson(join(stateDir, 'review-state.json'), null), agents: [...labels, 'com.ketu.dk2watch'].map(label => ({ label, loaded: run('launchctl', ['print', `${domain}/${label}`]).status === 0 })) }, null, 2))
} else throw new Error('Use status, pause, resume, install, retire-old, or uninstall')
