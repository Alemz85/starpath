/**
 * schedule-launchd.mjs — install, remove and inspect the LaunchAgent.
 *
 * Everything that touches the machine takes its effects as parameters
 * (`run` for launchctl, `plistDir`, `home`), so the tests drive it against a
 * temp folder with a fake launchctl and never touch ~/Library/LaunchAgents.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { LABEL, LAUNCHD_LOG_REL, buildPlist } from './schedule-core.mjs'

export const DEFAULT_PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents')

export function plistPathFor(plistDir = DEFAULT_PLIST_DIR, label = LABEL) {
  return join(plistDir, `${label}.plist`)
}

const isExecutable = (p) => { try { accessSync(p, constants.X_OK); return true } catch { return false } }

/**
 * First executable called `name` on `pathEnv`, WITHOUT resolving links:
 * /opt/homebrew/bin/node survives `brew upgrade`, the Cellar path it points
 * at does not.
 */
export function resolveBinary(name, pathEnv = process.env.PATH ?? '', executable = isExecutable) {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const p = join(dir, name)
    if (executable(p)) return p
  }
  return null
}

/** PATH for the job: where node and claude live, then the usual tool folders. */
export function jobPath({ nodePath, claudePath }) {
  const dirs = [nodePath && dirname(nodePath), claudePath && dirname(claudePath),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return [...new Set(dirs.filter(Boolean))].join(delimiter)
}

const launchctl = (args) => execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * Write the plist and (unless `load` is false) load it into the user's GUI
 * domain. Re-running replaces the loaded job, which is how a new slot takes
 * effect. Returns { plistPath, plist, loaded }.
 */
export function installJob({
  root, slot, nodePath, claudePath, scriptPath = join(root, 'scripts', 'scheduled-run.mjs'),
  plistDir = DEFAULT_PLIST_DIR, home = homedir(), uid = process.getuid?.(), run = launchctl, load = true,
}) {
  if (!nodePath) throw new Error('install: node was not found on PATH')
  const logPath = join(root, LAUNCHD_LOG_REL)
  const plist = buildPlist({ nodePath, scriptPath, root, slot, pathEnv: jobPath({ nodePath, claudePath }), home, logPath })
  const plistPath = plistPathFor(plistDir)
  mkdirSync(plistDir, { recursive: true })
  writeFileSync(plistPath, plist, 'utf8')
  let loaded = false
  if (load) {
    try { run(['bootout', `gui/${uid}/${LABEL}`]) } catch { /* not loaded yet */ }
    run(['bootstrap', `gui/${uid}`, plistPath])
    loaded = true
  }
  return { plistPath, plist, loaded }
}

/** Unload the job and delete the plist. Both parts are best-effort and idempotent. */
export function uninstallJob({ plistDir = DEFAULT_PLIST_DIR, uid = process.getuid?.(), run = launchctl, load = true } = {}) {
  const plistPath = plistPathFor(plistDir)
  const existed = existsSync(plistPath)
  if (load) { try { run(['bootout', `gui/${uid}/${LABEL}`]) } catch { /* not loaded */ } }
  rmSync(plistPath, { force: true })
  return { plistPath, existed }
}

/** The parts of a plist written by buildPlist that the status check cares about. */
export function inspectPlist(text) {
  const str = (re) => { const m = re.exec(text); return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null }
  const args = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
  const slots = [...text.matchAll(/<key>Weekday<\/key><integer>(\d)<\/integer>\s*<key>Hour<\/key><integer>(\d+)<\/integer>\s*<key>Minute<\/key><integer>(\d+)<\/integer>/g)]
    .map((m) => ({ weekday: Number(m[1]), hour: Number(m[2]), minute: Number(m[3]) }))
  return {
    nodePath: args[0] ?? null,
    scriptPath: args[1] ?? null,
    root: str(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/),
    pathEnv: str(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/),
    slots,
  }
}

/**
 * Is the job installed and loaded, and is what is installed still right?
 * `expect` = { slot, root }. `problems` lists, in words, what no longer
 * holds: a different slot or checkout, a node or script that has moved, a PATH
 * that no longer reaches `claude`. A non-empty list means "run install again".
 */
export function jobStatus({
  plistDir = DEFAULT_PLIST_DIR, uid = process.getuid?.(), run = launchctl, load = true,
  expect = null, executable = isExecutable, exists = existsSync,
} = {}) {
  const plistPath = plistPathFor(plistDir)
  const installed = exists(plistPath)
  let loaded = false
  if (installed && load) {
    try { run(['print', `gui/${uid}/${LABEL}`]); loaded = true } catch { loaded = false }
  }
  const problems = []
  if (installed) {
    let info = null
    try { info = inspectPlist(readFileSync(plistPath, 'utf8')) } catch { problems.push('the plist cannot be read') }
    if (info) {
      if (expect?.slot) {
        const first = info.slots[0]
        if (!first || first.weekday !== expect.slot.weekday || first.hour !== expect.slot.hour || first.minute !== (expect.slot.minute ?? 0)) {
          problems.push('the installed slot differs from the saved one')
        }
      }
      if (expect?.root && info.root !== expect.root) problems.push(`the job points at ${info.root}, not ${expect.root}`)
      if (info.nodePath && !executable(info.nodePath)) problems.push(`node is no longer at ${info.nodePath}`)
      if (info.scriptPath && !exists(info.scriptPath)) problems.push(`${info.scriptPath} does not exist`)
      const hasClaude = (info.pathEnv ?? '').split(delimiter).some((d) => d && executable(join(d, 'claude')))
      if (!hasClaude) problems.push('the claude CLI is not reachable from the job PATH')
    }
  }
  return { installed, loaded, plistPath, upToDate: installed ? problems.length === 0 : null, problems }
}
