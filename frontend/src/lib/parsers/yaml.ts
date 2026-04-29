import type { Phase, ProfileConfig } from '@/types'

// Lightweight YAML key:value parser — handles nested blocks and lists.
// Only covers the subset used in profile.yml and user/portals.yml.
// For full YAML parsing, js-yaml is available but adds bundle weight to the renderer.
// We load it dynamically only when writing files.

export function parseProfileYaml(raw: string): Partial<ProfileConfig> {
  try {
    // Use a simple line-by-line approach for the fields we need
    const lines = raw.split('\n')
    const result: Partial<ProfileConfig> & Record<string, unknown> = {}

    let currentSection = ''
    let currentSubSection = ''

    for (const line of lines) {
      if (line.trim().startsWith('#') || !line.trim()) continue

      const indent = line.match(/^(\s*)/)?.[1].length ?? 0
      const content = line.trim()

      if (indent === 0) {
        const [key, ...rest] = content.split(':')
        const val = rest.join(':').trim()
        currentSection = key.trim()
        currentSubSection = ''
        if (val) (result as Record<string, unknown>)[currentSection] = val
        else (result as Record<string, unknown>)[currentSection] = {}
      } else if (indent === 2 && currentSection) {
        const [key, ...rest] = content.split(':')
        const val = rest.join(':').trim()
        const section = (result as Record<string, unknown>)[currentSection]
        if (section && typeof section === 'object') {
          currentSubSection = key.trim()
          ;(section as Record<string, unknown>)[currentSubSection] = val.replace(/^["']|["']$/g, '')
        }
      }
    }

    result.phase = getPhase(raw)

    // Extract candidate fields
    const candidateMatch = raw.match(/candidate:([\s\S]*?)(?=\n\w|\n#|$)/)
    if (candidateMatch) {
      const block = candidateMatch[1]
      const extract = (key: string) => block.match(new RegExp(`${key}:\\s*["']?([^"'\\n]+)["']?`))?.[1]?.trim()
      result.candidate = {
        full_name: extract('full_name') ?? '',
        email:     extract('email') ?? '',
        phone:     extract('phone'),
        location:  extract('location'),
        linkedin:  extract('linkedin'),
        portfolio_url: extract('portfolio_url'),
        github:    extract('github'),
      }
    }

    return result as Partial<ProfileConfig>
  } catch {
    return {}
  }
}

// Read the user's phase from profile.yml. Accepts the canonical `phase` key
// and migrates the historical `current_mode` key (whose values were
// scouting/applying/job-seeking) into the phase vocabulary.
export function getPhase(raw: string): Phase {
  const phaseMatch = raw.match(/^phase:\s*([^\s#]+)/m)
  const phaseVal = phaseMatch?.[1]?.replace(/['"]/g, '').trim()
  if (phaseVal === 'applying') return 'applying'
  if (phaseVal === 'exploring') return 'exploring'

  const legacyMatch = raw.match(/^current_mode:\s*([^\s#]+)/m)
  const legacyVal = legacyMatch?.[1]?.replace(/['"]/g, '').trim()
  if (legacyVal === 'applying' || legacyVal === 'job-seeking') return 'applying'
  // Anything else (`scouting`, missing, malformed) defaults to `exploring`.
  return 'exploring'
}

// Write the phase to profile.yml. If the file still uses the legacy
// `current_mode` key, replace it with `phase` and the corresponding value
// (so we converge on a single key over time). If neither key is present,
// inject `phase` at the top of the file.
export function setPhase(raw: string, phase: Phase): string {
  if (/^phase:\s*\S+/m.test(raw)) {
    return raw.replace(/^(phase:\s*)\S+/m, `$1${phase}`)
  }
  if (/^current_mode:\s*\S+/m.test(raw)) {
    return raw.replace(/^current_mode:\s*\S+/m, `phase: ${phase}`)
  }
  // No existing key — prepend.
  return `phase: ${phase}\n\n${raw}`
}

// True if the raw profile.yml still uses the legacy `current_mode` key, so
// the launch routine can rewrite it once and then forget about it.
export function hasLegacyMode(raw: string): boolean {
  return /^current_mode:\s*\S+/m.test(raw)
}
