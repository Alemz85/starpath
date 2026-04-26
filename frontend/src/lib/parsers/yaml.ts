import type { ProfileConfig } from '@/types'

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
      result.current_mode = modeMatch[1].replace(/['"]/g, '') as ProfileConfig['current_mode']
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

export function getCurrentMode(raw: string): 'scouting' | 'job-seeking' {
  const match = raw.match(/^current_mode:\s*([^\s#]+)/m)
  const val = match?.[1]?.replace(/['"]/g, '').trim()
  return val === 'job-seeking' ? 'job-seeking' : 'scouting'
}

export function setCurrentMode(raw: string, mode: 'scouting' | 'job-seeking'): string {
  return raw.replace(/^(current_mode:\s*)(\S+)/m, `$1${mode}`)
}
