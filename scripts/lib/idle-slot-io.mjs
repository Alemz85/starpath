/**
 * idle-slot-io.mjs — the file/process side of the idle-slot picker.
 *
 * Reads only timestamps: from Claude Code transcripts (`~/.claude/projects/**\/*.jsonl`)
 * it extracts the value of each line's top-level `"timestamp"` field and drops
 * the line, never parsing or keeping message content. The power log comes from
 * `pmset -g log`. The maths lives in idle-slot-core.mjs.
 */

import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'
import { parsePmsetAwake } from './idle-slot-core.mjs'

const TS_MARKER = '"timestamp":"'

/** Every .jsonl under `dir` modified at or after `sinceMs`. */
export function listTranscripts(dir, sinceMs = 0) {
  const out = []
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) {
        try { if (statSync(p).mtimeMs >= sinceMs) out.push(p) } catch { /* vanished */ }
      }
    }
  }
  walk(dir)
  return out
}

/** The ISO timestamp on a transcript line as epoch ms, or null. Content is never parsed. */
export function lineTimestamp(line) {
  const i = line.indexOf(TS_MARKER)
  if (i < 0) return null
  const start = i + TS_MARKER.length
  const end = line.indexOf('"', start)
  if (end < 0 || end - start > 40) return null
  const ms = Date.parse(line.slice(start, end))
  return Number.isFinite(ms) ? ms : null
}

/** Epoch-ms timestamps of every transcript line since `sinceMs`. */
export async function collectClaudeTimestamps({ projectsDir = join(homedir(), '.claude', 'projects'), sinceMs = 0 } = {}) {
  const stamps = []
  for (const file of listTranscripts(projectsDir, sinceMs)) {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      const ms = lineTimestamp(line)
      if (ms !== null && ms >= sinceMs) stamps.push(ms)
    }
  }
  return stamps
}

/** Full-wake intervals from `pmset -g log`; empty (and `from` null) when it can't be read. */
export function collectAwakeIntervals({ now = Date.now(), run = () => execFileSync('pmset', ['-g', 'log'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }) } = {}) {
  let text
  try { text = run() } catch { return { intervals: [], from: null } }
  return parsePmsetAwake(text, { now })
}
