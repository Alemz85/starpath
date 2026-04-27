import type { AppMode, ProfileConfig } from '@/types'

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

    // Parse current_mode directly from raw string (top-level scalar)
    const modeMatch = raw.match(/^current_mode:\s*(\S+)/m)
    if (modeMatch) {
      const v = modeMatch[1].replace(/['"]/g, '')
      // Migrate legacy `job-seeking` to `applying` on read.
      result.current_mode = (v === 'job-seeking' ? 'applying' : v) as ProfileConfig['current_mode']
    }

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

export function getCurrentMode(raw: string): AppMode {
  const match = raw.match(/^current_mode:\s*([^\s#]+)/m)
  const val = match?.[1]?.replace(/['"]/g, '').trim()
  // Legacy `job-seeking` aliases to `applying`.
  if (val === 'applying' || val === 'job-seeking') return 'applying'
  return 'scouting'
}

export function setCurrentMode(raw: string, mode: AppMode): string {
  // Always write canonical (`applying` / `scouting`); also rewrites legacy `job-seeking`.
  return raw.replace(/^(current_mode:\s*)(\S+)/m, `$1${mode}`)
}

// True if the raw profile.yml still has a legacy `job-seeking` value that we
// should rewrite once on launch.
export function hasLegacyMode(raw: string): boolean {
  return /^current_mode:\s*job-seeking/m.test(raw)
}
