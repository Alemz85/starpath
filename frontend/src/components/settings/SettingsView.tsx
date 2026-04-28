'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useSpawnsStore, claudeArgs } from '@/store/spawns'
import { useConfigDirty } from '@/store/configDirty'
import { ipc } from '@/lib/ipc'
import { FolderOpen, Check, RefreshCw, Sparkles, X, Plus, ChevronRight, Search, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Role suggestion graph ────────────────────────────────────────────────────

const ROLE_GRAPH: Record<string, readonly string[]> = {
  'Business Analyst':       ['Data Analyst', 'Product Analyst', 'Strategy Analyst', 'Operations Analyst', 'Management Consultant', 'Financial Analyst'],
  'Data Analyst':           ['Business Analyst', 'Analytics Engineer', 'Data Scientist', 'Product Analyst', 'Strategy & Operations', 'BI Analyst'],
  'Strategy Analyst':       ['Business Analyst', 'Strategy & Operations', 'Management Consultant', 'FP&A Analyst', 'Corporate Strategy', 'Operations Analyst'],
  'Strategy & Operations':  ['Strategy Analyst', 'Operations Analyst', 'Business Analyst', 'Revenue Operations', 'Product Operations', 'Program Manager'],
  'Operations Analyst':     ['Business Analyst', 'Strategy & Operations', 'Data Analyst', 'Process Analyst', 'Project Manager'],
  'Product Analyst':        ['Data Analyst', 'Business Analyst', 'Product Manager', 'Growth Analyst', 'Product Operations'],
  'Financial Analyst':      ['FP&A Analyst', 'Business Analyst', 'Strategy Analyst', 'Corporate Finance', 'Investment Analyst'],
  'FP&A Analyst':           ['Financial Analyst', 'Corporate Finance', 'Strategy Analyst', 'Business Analyst'],
  'Management Consultant':  ['Strategy Analyst', 'Business Analyst', 'Corporate Finance', 'Change Management', 'Program Manager'],
  'Data Scientist':         ['Data Analyst', 'ML Engineer', 'Analytics Engineer', 'Research Scientist', 'Data Engineer'],
  'ML Engineer':            ['Data Scientist', 'AI Engineer', 'Data Engineer', 'Platform Engineer', 'Research Engineer'],
  'AI Engineer':            ['ML Engineer', 'Data Scientist', 'Backend Engineer', 'Solutions Architect', 'Applied AI Engineer'],
  'Applied AI Engineer':    ['AI Engineer', 'ML Engineer', 'Solutions Architect', 'AI Product Manager', 'Data Scientist'],
  'AI Product Manager':     ['Product Manager', 'Applied AI Engineer', 'Strategy & Operations', 'AI Engineer', 'Data Scientist'],
  'Data Engineer':          ['Analytics Engineer', 'ML Engineer', 'Platform Engineer', 'Backend Engineer', 'Data Scientist'],
  'Analytics Engineer':     ['Data Engineer', 'Data Analyst', 'Data Scientist', 'BI Analyst', 'Backend Engineer'],
  'Product Manager':        ['Product Analyst', 'Strategy & Operations', 'Business Analyst', 'Program Manager', 'Growth Analyst'],
  'Growth Analyst':         ['Product Analyst', 'Marketing Analyst', 'Data Analyst', 'Revenue Operations', 'Performance Analyst'],
  'Revenue Operations':     ['Strategy & Operations', 'Growth Analyst', 'Sales Operations', 'Business Analyst', 'Financial Analyst'],
  'Solutions Architect':    ['AI Engineer', 'Technical Consultant', 'Pre-Sales Engineer', 'Backend Engineer', 'Applied AI Engineer'],
  'Technical Consultant':   ['Solutions Architect', 'Management Consultant', 'Business Analyst', 'Pre-Sales Engineer'],
  'Program Manager':        ['Project Manager', 'Strategy & Operations', 'Business Analyst', 'Product Manager'],
  'Marketing Analyst':      ['Growth Analyst', 'Data Analyst', 'Product Analyst', 'Business Analyst', 'Performance Analyst'],
  'BI Analyst':             ['Data Analyst', 'Analytics Engineer', 'Business Analyst', 'Data Scientist'],
  'Corporate Finance':      ['Financial Analyst', 'FP&A Analyst', 'Investment Analyst', 'Strategy Analyst'],
  'Investment Analyst':     ['Corporate Finance', 'Financial Analyst', 'Strategy Analyst'],
  'Backend Engineer':       ['Data Engineer', 'Platform Engineer', 'AI Engineer', 'ML Engineer', 'Solutions Architect'],
  'Performance Analyst':    ['Marketing Analyst', 'Growth Analyst', 'Data Analyst', 'Business Analyst'],
  'Sales Operations':       ['Revenue Operations', 'Strategy & Operations', 'Business Analyst', 'Growth Analyst'],
  'Process Analyst':        ['Operations Analyst', 'Business Analyst', 'Data Analyst', 'Program Manager'],
  'Corporate Strategy':     ['Strategy Analyst', 'Management Consultant', 'Corporate Finance', 'Business Analyst'],
  'Change Management':      ['Management Consultant', 'Program Manager', 'Strategy & Operations'],
}

const ROLE_GRAPH_KEYS = Object.keys(ROLE_GRAPH).sort()

function getSuggestions(selected: string[]): string[] {
  if (selected.length === 0) return []
  const selectedSet = new Set(selected)
  const freq: Record<string, number> = {}
  for (const role of selected) {
    for (const adj of ROLE_GRAPH[role] ?? []) {
      if (!selectedSet.has(adj)) freq[adj] = (freq[adj] ?? 0) + 1
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([r]) => r)
}

// ─── YAML helpers ─────────────────────────────────────────────────────────────

// Identity / compensation extract+patch helpers moved to ProfileEditPanel
// when the user-config form moved out of Settings. The remaining helpers
// here are role-list and portals-keyword block parsers used by the tabs
// that stayed in Settings.

const extractPrimaryRoles = (yaml: string): string[] => {
  const block = yaml.match(/primary:\s*([\s\S]*?)(?=\n  \w|\n#|$)/)?.[1] ?? ''
  return [...block.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?/gm)]
    .map(m => m[1].trim())
    .filter(Boolean)
}

const extractPortalKeywords = (yaml: string, type: 'positive' | 'negative'): string[] => {
  const section = yaml.match(/title_filter:\s*([\s\S]*?)(?=\n\S|\n#|$)/)?.[1] ?? ''
  const block = section.match(new RegExp(`${type}:([\\s\\S]*?)(?=\\n\\s{2}\\w|\\n#|$)`))?.[1] ?? ''
  return [...block.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?/gm)]
    .map(m => m[1].trim())
    .filter(Boolean)
}

// ─── Portals-specific YAML helpers ───────────────────────────────────────────

interface CompanyEntry {
  name: string
  enabled: boolean
  notes: string
  careers_url: string
  /** Detected scan method — `api` if the entry has an `api:` URL,
   *  `websearch` when `scan_method: websearch` is present, `unknown`
   *  otherwise (block has neither, e.g. probe still running). */
  scan_method: 'api' | 'websearch' | 'unknown'
}

function parseCompanies(yaml: string): CompanyEntry[] {
  const section = yaml.split('tracked_companies:')[1] ?? ''
  return section
    .split('\n  - name: ')
    .slice(1)
    .map(block => {
      const name = block.split('\n')[0].trim()
      if (!name) return null
      const enabled = !block.includes('enabled: false')
      const notes = block.match(/notes:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1]?.trim() ?? ''
      const careers_url = block.match(/careers_url:\s*(\S+)/)?.[1]?.trim() ?? ''
      const has_api = /\n\s+api:\s*\S/.test(block)
      const is_ws  = /scan_method:\s*websearch/.test(block)
      const scan_method: CompanyEntry['scan_method'] =
        has_api ? 'api' : is_ws ? 'websearch' : 'unknown'
      return { name, enabled, notes, careers_url, scan_method }
    })
    .filter((c): c is CompanyEntry => c !== null && c.name.length > 0)
}

function setCompanyEnabled(yaml: string, companyName: string, enabled: boolean): string {
  const lines = yaml.split('\n')
  let inTarget = false
  return lines.map(line => {
    const trimmed = line.trimStart()
    if (trimmed === `- name: ${companyName}`) inTarget = true
    else if (inTarget && trimmed.startsWith('- name:')) inTarget = false
    if (inTarget && /^\s+enabled:/.test(line)) {
      return line.replace(/enabled:\s*(true|false)/, `enabled: ${enabled}`)
    }
    return line
  }).join('\n')
}

function removeCompany(yaml: string, companyName: string): string {
  const lines = yaml.split('\n')
  let skip = false
  const result: string[] = []
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (trimmed === `- name: ${companyName}`) { skip = true; continue }
    if (skip && trimmed.startsWith('- name:')) skip = false
    if (!skip) result.push(line)
  }
  return result.join('\n')
}

function addCompany(yaml: string, name: string, url: string): string {
  const domain = url.replace(/^https?:\/\//, '').split('/')[0]
  const block = [
    '',
    `  - name: ${name}`,
    `    careers_url: ${url}`,
    `    scan_method: websearch`,
    `    scan_query: 'site:${domain} {{roles_default}}'`,
    `    notes: ""`,
    `    enabled: true`,
  ].join('\n')
  // Append before the first non-tracked_companies top-level section after it
  const idx = yaml.lastIndexOf('\n  - name:')
  if (idx === -1) return yaml + block
  // Find end of last company block (next blank line at root or new top-level key)
  const after = yaml.indexOf('\n\n', idx)
  if (after === -1) return yaml + block
  return yaml.slice(0, after) + block + yaml.slice(after)
}

// Spawn prompt for the "add company" flow. The user adds a name + careers
// URL through the UI; this prompt instructs Claude to probe the common
// ATS APIs (Greenhouse / Ashby / Lever / SmartRecruiters / Workday) using
// candidate slugs derived from the name + URL, and rewrite the placeholder
// portals.yml block with the right config when one returns valid data —
// or keep the websearch fallback (and craft a sharp scan_query) when no
// API matches. Concrete URLs go in the prompt so Claude doesn't have to
// guess the API shape.
function buildCompanyProbePrompt(name: string, careersUrl: string): string {
  return [
    `The user just added "${name}" to user/portals.yml under tracked_companies.`,
    `careers_url: ${careersUrl || '(not provided)'}`,
    '',
    'Right now the entry has a placeholder block (scan_method: websearch with a generic scan_query). Probe the common ATS endpoints to figure out the actual hosting platform, then REPLACE that one block with the correct config. Do not touch any other entry in tracked_companies.',
    '',
    'Probe order (use WebFetch; treat 200 + non-empty JSON body as a positive match):',
    '',
    '1. **Greenhouse** — https://boards-api.greenhouse.io/v1/boards/{slug}/jobs',
    '   Try several slugs derived from the name: lowercase no-spaces, lowercase hyphenated, lowercase no special chars. e.g. for "Red Bull": redbull, red-bull.',
    '',
    '2. **Ashby** — https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true',
    '   Same slug variants as above.',
    '',
    '3. **Lever** — https://api.lever.co/v0/postings/{slug}?mode=json',
    '   Same slug variants.',
    '',
    '4. **SmartRecruiters** — https://api.smartrecruiters.com/v1/companies/{slug}/postings',
    '   Try CamelCase no-spaces, lowercase no-spaces, and TitleCase variants. e.g. for "Red Bull": RedBull. Some companies post under a parent brand (e.g. Glovo postings live under DeliveryHero with brand=Glovo) — note this in the entry if discovered.',
    '',
    '5. **Workday** — careers URL like `*.myworkdayjobs.com/*` is the strongest signal. If careers_url contains a wd subdomain (wd1, wd3, wd103, etc), construct the API as `{base}/wday/cxs/{tenant}/{site}/jobs`. e.g. https://accenture.wd103.myworkdayjobs.com/wday/cxs/accenture/AccentureCareers/jobs.',
    '',
    'On a positive match, REPLACE the entry block with:',
    '```yaml',
    `  - name: ${name}`,
    `    careers_url: ${careersUrl || '<the canonical careers page>'}`,
    '    api: <the URL that returned data>',
    '    notes: "<one sentence — preferred cities, what to look for, ATS detected>"',
    '    enabled: true',
    '```',
    '',
    'On NO positive match, REPLACE the entry block with:',
    '```yaml',
    `  - name: ${name}`,
    `    careers_url: ${careersUrl || '<the canonical careers page>'}`,
    '    scan_method: websearch',
    '    scan_query: \'site:<canonical-careers-domain> {{roles_default}}\'',
    '    notes: "<one sentence — why no API was found, e.g. proprietary portal / SAP SuccessFactors>"',
    '    enabled: true',
    '```',
    '',
    'Edit the existing placeholder block in user/portals.yml — find the line `- name: ' + name + '` and replace just that block. Do not regenerate the whole file. Do not modify other companies. When done, write a one-line summary of what was found.',
  ].join('\n')
}

function parseLangBlocklist(yaml: string): string[] {
  const section = yaml.split('lang_blocklist:')[1]?.split(/\n[a-z_]+:/)[0] ?? ''
  return [...section.matchAll(/^\s*-\s*["']?([^"'\n#][^"'\n]*)["']?/gm)]
    .map(m => m[1].trim())
    .filter(Boolean)
}

function setLangBlocklist(yaml: string, items: string[]): string {
  const block = items.map(i => `  - "${i}"`).join('\n')
  return yaml.replace(
    /(lang_blocklist:\n)([\s\S]*?)(?=\n[a-z_]+:)/,
    `$1${block}\n`
  )
}

// ─── Root component ───────────────────────────────────────────────────────────

// All editable user-data tabs (Candidate / Roles / Portals) moved to the
// new Configuration tab. Settings now only hosts app-level controls
// (repo path, mode, model selection, etc) which the GeneralTab handles.
// RolesTab / PortalsTab are still exported from this file so Configuration
// can import them directly.

export function SettingsView() {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Settings</h1>
      </div>
      <div className="flex-1 overflow-y-auto">
        <GeneralTab />
      </div>
    </div>
  )
}

// ─── General tab ──────────────────────────────────────────────────────────────

function GeneralTab() {
  const { repoPath, setRepoPath, currentMode, setMode, models, setModel, resetTailoring } = useAppStore()
  const { refresh } = useDataStore()

  const MODEL_ROWS: Array<{
    key: 'pipeline' | 'tailorCv' | 'draftApp' | 'interviewPrep' | 'generateReport'
    label: string
    sub: string
  }> = [
    { key: 'pipeline',       label: 'Filter to Database',     sub: 'Score-only run that filters pending URLs and writes scoring rows to data/scouting.md. Also editable via the Model chip on the Scouting cockpit.' },
    { key: 'tailorCv',       label: 'Tailor CV',              sub: 'Per-listing CV regeneration on the Applying tab (modes/pdf.md).' },
    { key: 'draftApp',       label: 'Draft Application',      sub: 'Per-listing form-fill draft on the Applying tab (modes/apply.md).' },
    { key: 'interviewPrep',  label: 'Prep Interview',         sub: 'Per-listing interview brief generation (modes/interview-prep.md).' },
    { key: 'generateReport', label: 'Generate Report',        sub: 'Full per-listing prose reports — used by both the Reports tab Generate Top 5 button and the per-listing Generate Report action in the Database popover.' },
  ]

  const changeRepo = async () => {
    const result = await ipc.selectFolder()
    if (result?.valid) { setRepoPath(result.path); await refresh() }
  }

  return (
    <div>
      <SettingRow title="Repository" description="The local career-ops folder Claude reads and writes to.">
        <div className="flex items-center gap-2 mt-3">
          <div className="flex-1 px-3 py-2 rounded-md border border-border-default bg-bg-elevated text-label text-text-3 font-mono truncate">
            {repoPath ?? 'Not set'}
          </div>
          <button
            onClick={changeRepo}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-border-default text-label text-text-2 hover:bg-bg-elevated transition-colors shrink-0"
          >
            <FolderOpen size={13} />
            Change
          </button>
        </div>
      </SettingRow>

      <SettingRow title="Mode" description="Controls how pasted JDs are evaluated by default. Also reflects which top tab (Scouting / Applying) is active. Override per-invocation with /career-ops scouting or /career-ops oferta.">
        <div className="flex rounded-md overflow-hidden border border-border-default w-fit mt-3">
          {(['scouting', 'applying'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setMode(mode)}
              className={cn(
                'px-4 py-2 text-label transition-colors capitalize',
                currentMode === mode ? 'bg-accent/20 text-accent-text' : 'text-text-4 hover:text-text-2',
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        title="Models"
        description="Pick the Claude model used for each category of work. Sonnet is cheaper and fast; Opus is more thorough."
      >
        <div className="mt-4 space-y-4">
          {MODEL_ROWS.map(row => (
            <ModelChoice
              key={row.key}
              label={row.label}
              sub={row.sub}
              value={models[row.key]}
              onChange={(m) => setModel(row.key, m)}
            />
          ))}
        </div>
      </SettingRow>

      <SettingRow title="Data" description="Reload all data files from disk if they were modified outside the app.">
        {/* Shift-click forces a full SQLite resync from the markdown/TSV
            sources — useful when debugging cache divergence. Plain click
            just re-reads from the DB (the watcher keeps it current). */}
        <button
          onClick={(e) => refresh({ resync: e.shiftKey })}
          className="flex items-center gap-1.5 px-3 py-2 mt-3 rounded-md border border-border-default text-label text-text-2 hover:bg-bg-elevated transition-colors"
        >
          <RefreshCw size={13} />
          Refresh data
        </button>
      </SettingRow>

      <SettingRow title="Workspace tuning" description="Re-run Claude to regenerate keyword filters and candidate context from your CV and profile.">
        <button
          onClick={resetTailoring}
          className="flex items-center gap-1.5 px-3 py-2 mt-3 rounded-md border border-border-default text-label text-text-2 hover:bg-bg-elevated transition-colors"
        >
          <Sparkles size={13} />
          Re-tune workspace
        </button>
      </SettingRow>
    </div>
  )
}


// ─── Roles tab ────────────────────────────────────────────────────────────────
//
// Exported so the Configuration tab (frontend/src/components/configuration/
// ConfigurationView.tsx) can mount it. Also still rendered here as a
// secondary entry until the Settings tab is fully trimmed.

export function RolesTab() {
  const [raw, setRaw] = useState<string | null>(null)
  const [roles, setRoles] = useState<string[]>([])
  const [baselineRoles, setBaselineRoles] = useState<string[]>([])
  const [addInput, setAddInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const setConfigDirty = useConfigDirty(s => s.setDirty)

  useEffect(() => {
    ipc.readFile('user/profile.yml').then(text => {
      if (!text) return
      const loaded = extractPrimaryRoles(text)
      setRaw(text)
      setRoles(loaded)
      setBaselineRoles(loaded)
    })
  }, [])

  // Mark Roles tab dirty when the primary-roles list diverges from what
  // we loaded. Dream Companies + Target Locations have their own save
  // buttons and dirty-track separately under different source ids, so
  // they coexist cleanly.
  useEffect(() => {
    const dirty = JSON.stringify(roles) !== JSON.stringify(baselineRoles)
    setConfigDirty('roles', 'roles-primary', dirty)
  }, [roles, baselineRoles, setConfigDirty])
  useEffect(() => () => setConfigDirty('roles', 'roles-primary', false), [setConfigDirty])

  const registerSaveHandler = useConfigDirty(s => s.registerSaveHandler)
  useEffect(() => {
    registerSaveHandler('roles-primary', handleSave)
    return () => registerSaveHandler('roles-primary', null)
  })

  const addRole = (role: string) => {
    const r = role.trim()
    if (r && !roles.includes(r)) setRoles(prev => [...prev, r])
    setAddInput('')
  }
  const removeRole = (role: string) => setRoles(prev => prev.filter(r => r !== role))
  const suggestions = getSuggestions(roles)

  const handleSave = async () => {
    if (raw === null) return
    setSaving(true)
    const block = roles.map(r => `    - "${r}"`).join('\n')
    let u = raw
    if (u.match(/\n  primary:\n/)) {
      u = u.replace(/(  primary:\n)([\s\S]*?)(?=\n  \w|\n#|$)/, `$1${block}\n`)
    } else if (u.includes('target_roles:')) {
      u = u.replace('target_roles:', `target_roles:\n  primary:\n${block}`)
    } else {
      u += `\ntarget_roles:\n  primary:\n${block}\n`
    }
    await ipc.writeFile('user/profile.yml', u)
    setRaw(u)
    setBaselineRoles(roles)   // dirty resets — current state is now the baseline
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  if (raw === null) return <LoadingRows />

  return (
    <div>
      <SettingRow
        title="Selected roles"
        description="Role archetypes the system uses to score fit. Select as many as apply — the more specific, the better the scoring."
      >
        <div className="mt-4 flex flex-wrap gap-2 min-h-[38px]">
          {roles.length === 0 ? (
            <span className="text-label text-text-4 self-center italic">No roles selected — pick from suggestions or browse below.</span>
          ) : (
            roles.map(role => (
              <span key={role} className="inline-flex items-center gap-2 pl-2.5 pr-2 py-1.5 rounded-lg bg-accent/15 border border-accent/35 text-accent-text text-label font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-accent/70 shrink-0" />
                {role}
                <button onClick={() => removeRole(role)} className="text-accent-text/40 hover:text-accent-text transition-colors">
                  <X size={11} />
                </button>
              </span>
            ))
          )}
        </div>

        {suggestions.length > 0 && (
          <div className="mt-5">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-micro font-semibold text-text-4 uppercase tracking-widest">Related</span>
              <div className="flex-1 h-px bg-border-default" />
            </div>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((role, i) => (
                <button
                  key={role}
                  onClick={() => addRole(role)}
                  className="suggestion-chip inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-border-strong text-text-3 text-label hover:border-accent/50 hover:text-accent-text hover:bg-accent/10 active:scale-95 transition-all duration-150"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <Plus size={10} className="text-text-4 shrink-0" />
                  {role}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5">
          <input
            ref={inputRef}
            value={addInput}
            onChange={e => setAddInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addRole(addInput) } }}
            placeholder="Add a custom role and press Enter…"
            className="w-full px-3 h-9 bg-bg-elevated border border-border-default focus:border-accent/50 outline-none rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors"
          />
        </div>
      </SettingRow>

      <SettingRow title="Browse all" description="All archetypes in the suggestion graph. Click any to add or remove.">
        <div className="mt-3 flex flex-wrap gap-1.5">
          {ROLE_GRAPH_KEYS.map(role => {
            const selected = roles.includes(role)
            return (
              <button
                key={role}
                onClick={() => selected ? removeRole(role) : addRole(role)}
                className={cn(
                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-micro transition-all duration-100',
                  selected
                    ? 'bg-accent/15 border-accent/30 text-accent-text'
                    : 'border-border-default text-text-4 hover:border-border-strong hover:text-text-2',
                )}
              >
                {selected ? <Check size={9} /> : <Plus size={9} />}
                {role}
              </button>
            )
          })}
        </div>
      </SettingRow>

      <DreamCompaniesSection rawYaml={raw} />

      <TargetLocationsSection rawYaml={raw} />

      <div className="px-6 py-4 flex items-center justify-between border-t border-border-default">
        <p className="text-label text-text-4">
          Saved to <code className="text-accent/70 bg-bg-elevated px-1 py-0.5 rounded text-micro">target_roles.primary</code> in profile.yml
        </p>
        <button
          onClick={handleSave}
          disabled={saving || roles.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-accent/20 border border-accent/30 text-accent-text text-label rounded-md hover:bg-accent/30 disabled:opacity-40 transition-colors"
        >
          {saved ? <Check size={13} /> : null}
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save roles'}
        </button>
      </div>
    </div>
  )
}

// ─── Dream companies section (lives under RolesTab) ──────────────────────────
//
// The dream-companies block in profile.yml is structured (each entry has
// name + functions[] + priority + note). For the Configuration UI we
// only edit the names — anything richer can be hand-edited in the YAML.
// Existing per-name metadata is preserved when names stay in the list.

function DreamCompaniesSection({ rawYaml }: { rawYaml: string | null }) {
  const [names, setNames] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [raw, setRaw] = useState(rawYaml ?? '')
  const setConfigDirty = useConfigDirty(s => s.setDirty)

  useEffect(() => {
    setRaw(rawYaml ?? '')
    setNames(extractDreamCompanies(rawYaml ?? ''))
  }, [rawYaml])

  // The "did anything change since last load/save" check — drives both
  // the Save button's enabled state below AND the cross-cutting dirty
  // flag for the Roles tab.
  const dirty = JSON.stringify(extractDreamCompanies(raw)) !== JSON.stringify(names)
  useEffect(() => { setConfigDirty('roles', 'roles-dreams', dirty) }, [dirty, setConfigDirty])
  useEffect(() => () => setConfigDirty('roles', 'roles-dreams', false), [setConfigDirty])

  const registerSaveHandler = useConfigDirty(s => s.registerSaveHandler)
  useEffect(() => {
    registerSaveHandler('roles-dreams', handleSave)
    return () => registerSaveHandler('roles-dreams', null)
  })

  const add = () => {
    const v = input.trim()
    if (v && !names.some(n => n.toLowerCase() === v.toLowerCase())) {
      setNames(prev => [...prev, v])
    }
    setInput('')
  }
  const remove = (n: string) => setNames(prev => prev.filter(x => x !== n))

  const handleSave = async () => {
    setSaving(true)
    const u = patchDreamCompanies(raw, names)
    await ipc.writeFile('user/profile.yml', u)
    setRaw(u)
    setSaving(false)
    setSavedAt(Date.now())
    setTimeout(() => setSavedAt(null), 2500)
  }

  return (
    <SettingRow
      title="Dream companies"
      description="Floors Brand Value at 10 and Aspirational Fit at 8.0 in scoring — the user wants their foot in the door regardless of function match."
    >
      <div className="mt-4 flex flex-wrap gap-2 min-h-[38px]">
        {names.length === 0 ? (
          <span className="text-label text-text-4 italic self-center">No dream companies yet — add brands you'd most want to work for.</span>
        ) : (
          names.map(n => (
            <span key={n} className="inline-flex items-center gap-2 pl-2.5 pr-2 py-1.5 rounded-lg bg-tier-1/15 border border-tier-1/35 text-tier-1 text-label font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-tier-1/70 shrink-0" />
              {n}
              <button onClick={() => remove(n)} className="opacity-50 hover:opacity-100 transition-opacity">
                <X size={11} />
              </button>
            </span>
          ))
        )}
      </div>
      <div className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
          placeholder="Add a company (e.g. Stripe, Datadog) and press Enter…"
          className="flex-1 px-3 h-9 bg-bg-elevated border border-border-default focus:border-accent/50 outline-none rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors"
        />
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/20 border border-accent/30 text-accent-text text-label rounded-md hover:bg-accent/30 disabled:opacity-40 transition-colors"
        >
          {savedAt ? <Check size={12} /> : null}
          {saving ? 'Saving…' : savedAt ? 'Saved' : 'Save'}
        </button>
      </div>
    </SettingRow>
  )
}

function extractDreamCompanies(yaml: string): string[] {
  const m = yaml.match(/dream_companies:\s*\n([\s\S]*?)(?=\n  \w|\n\w|\n#|$)/)
  if (!m) return []
  const block = m[1]
  return [...block.matchAll(/^\s*-\s+name:\s*["']?([^"'\n]+)["']?/gm)]
    .map(x => x[1].trim())
    .filter(Boolean)
}

function patchDreamCompanies(yaml: string, names: string[]): string {
  // Preserve full per-name metadata when a name stays in the list. The
  // serialized block is reconstructed from these preserved chunks.
  const blockRe = /(  dream_companies:\s*\n)([\s\S]*?)(?=\n  \w|\n\w|\n#|$)/
  const m = yaml.match(blockRe)
  const existing = m ? m[2] : ''
  const preserved = new Map<string, string>()
  for (const chunk of existing.split(/\n  - name:/).slice(1)) {
    const head = chunk.split('\n')[0].trim().replace(/^["']|["']$/g, '')
    if (head) preserved.set(head, chunk)
  }
  const written = names
    .map(n => {
      const had = preserved.get(n)
      return had
        ? `  - name:${had}`
        : `  - name: "${n}"\n    priority: "top"`
    })
    .join('\n')
    + '\n'
  if (m) return yaml.replace(blockRe, `$1${written}`)
  if (yaml.includes('target_roles:')) {
    return yaml.replace('target_roles:', `target_roles:\n  dream_companies:\n${written}`)
  }
  return yaml + `\ntarget_roles:\n  dream_companies:\n${written}`
}

// ─── Target locations section (lives under RolesTab) ─────────────────────────
//
// Edits the `location.preferred_cities` list in profile.yml — the cities
// the user wants to work in, in priority order. Used by the scoring rubric
// for the Best Cities dimension and surfaced in the Trends Top Locations
// panel. Kept separate from Dream Companies because they're orthogonal
// signals — a Dublin role at Stripe and a Barcelona role at Stripe are
// the same company, different locations; the rubric scores them
// differently. (Older versions of this app collapsed both into a single
// concept because Claude's narrative output sometimes combined them in
// `_profile.md` — splitting here makes the structured signal cleaner.)

function TargetLocationsSection({ rawYaml }: { rawYaml: string | null }) {
  const [cities, setCities] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [raw, setRaw] = useState(rawYaml ?? '')
  const setConfigDirty = useConfigDirty(s => s.setDirty)

  useEffect(() => {
    setRaw(rawYaml ?? '')
    setCities(extractPreferredCities(rawYaml ?? ''))
  }, [rawYaml])

  const dirty = JSON.stringify(extractPreferredCities(raw)) !== JSON.stringify(cities)
  useEffect(() => { setConfigDirty('roles', 'roles-locations', dirty) }, [dirty, setConfigDirty])
  useEffect(() => () => setConfigDirty('roles', 'roles-locations', false), [setConfigDirty])

  const registerSaveHandler = useConfigDirty(s => s.registerSaveHandler)
  useEffect(() => {
    registerSaveHandler('roles-locations', handleSave)
    return () => registerSaveHandler('roles-locations', null)
  })

  const add = () => {
    const v = input.trim()
    if (v && !cities.some(c => c.toLowerCase() === v.toLowerCase())) {
      setCities(prev => [...prev, v])
    }
    setInput('')
  }
  const remove = (c: string) => setCities(prev => prev.filter(x => x !== c))
  const move = (c: string, dir: -1 | 1) => {
    setCities(prev => {
      const i = prev.indexOf(c)
      if (i === -1) return prev
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const handleSave = async () => {
    setSaving(true)
    const u = patchPreferredCities(raw, cities)
    await ipc.writeFile('user/profile.yml', u)
    setRaw(u)
    setSaving(false)
    setSavedAt(Date.now())
    setTimeout(() => setSavedAt(null), 2500)
  }

  return (
    <SettingRow
      title="Target locations"
      description="Cities you want to work in, in priority order. Drives the Best Cities scoring dimension — top of list scores 9-10, bottom of list 6-7, anything not listed scores lower."
    >
      <div className="mt-4 flex flex-wrap gap-2 min-h-[38px]">
        {cities.length === 0 ? (
          <span className="text-label text-text-4 italic self-center">No target locations yet — add the cities you'd actually relocate to.</span>
        ) : (
          cities.map((c, i) => (
            <span key={c} className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1.5 rounded-lg bg-info/10 border border-info/30 text-info text-label font-medium">
              <span className="font-mono text-info/60 text-[10px] mr-0.5">#{i + 1}</span>
              {c}
              <button
                onClick={() => move(c, -1)}
                disabled={i === 0}
                title="Move up"
                className="opacity-50 hover:opacity-100 disabled:opacity-20 transition-opacity p-0.5"
              >
                <ChevronRight size={11} className="-rotate-90" />
              </button>
              <button
                onClick={() => move(c, 1)}
                disabled={i === cities.length - 1}
                title="Move down"
                className="opacity-50 hover:opacity-100 disabled:opacity-20 transition-opacity p-0.5"
              >
                <ChevronRight size={11} className="rotate-90" />
              </button>
              <button onClick={() => remove(c)} className="opacity-50 hover:opacity-100 transition-opacity p-0.5">
                <X size={11} />
              </button>
            </span>
          ))
        )}
      </div>
      <div className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
          placeholder="Add a city (e.g. Dublin, Barcelona, Berlin) and press Enter…"
          className="flex-1 px-3 h-9 bg-bg-elevated border border-border-default focus:border-accent/50 outline-none rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors"
        />
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/20 border border-accent/30 text-accent-text text-label rounded-md hover:bg-accent/30 disabled:opacity-40 transition-colors"
        >
          {savedAt ? <Check size={12} /> : null}
          {saving ? 'Saving…' : savedAt ? 'Saved' : 'Save'}
        </button>
      </div>
    </SettingRow>
  )
}

function extractPreferredCities(yaml: string): string[] {
  // Look for `preferred_cities:` under the `location:` block. The block
  // is a flat YAML list of strings (`- "Dublin"`).
  const m = yaml.match(/preferred_cities:\s*\n([\s\S]*?)(?=\n\w|\n#|$)/)
  if (!m) return []
  return [...m[1].matchAll(/^\s*-\s+["']?([^"'\n]+)["']?/gm)]
    .map(x => x[1].trim()).filter(Boolean)
}

function patchPreferredCities(yaml: string, cities: string[]): string {
  const blockRe = /(  preferred_cities:\s*\n)([\s\S]*?)(?=\n\w|\n#|$)/
  const written = cities.map(c => `    - "${c}"`).join('\n') + '\n'
  if (yaml.match(blockRe)) {
    return yaml.replace(blockRe, `$1${written}`)
  }
  // Insert under the location: block if present, else append.
  if (yaml.match(/^location:\s*\n/m)) {
    return yaml.replace(/(^location:\s*\n(?:  [^\n]+\n)+)/m, m0 => `${m0.trimEnd()}\n  preferred_cities:\n${written}`)
  }
  return yaml + `\nlocation:\n  preferred_cities:\n${written}`
}

// ─── Portals tab ──────────────────────────────────────────────────────────────

export function PortalsTab() {
  const [raw, setRaw] = useState<string | null>(null)
  const [positive, setPositive] = useState<string[]>([])
  const [negative, setNegative] = useState<string[]>([])
  const [baselinePositive, setBaselinePositive] = useState<string[]>([])
  const [baselineNegative, setBaselineNegative] = useState<string[]>([])
  const [baselineLang, setBaselineLang] = useState<string[]>([])
  const [baselineRaw, setBaselineRaw] = useState<string>('')
  const [addPos, setAddPos] = useState('')
  const [addNeg, setAddNeg] = useState('')
  const [companies, setCompanies] = useState<CompanyEntry[]>([])
  const [companySearch, setCompanySearch] = useState('')
  const [showAddCompany, setShowAddCompany] = useState(false)
  const [newCompanyName, setNewCompanyName] = useState('')
  const [newCompanyUrl, setNewCompanyUrl] = useState('')
  const [langKeywords, setLangKeywords] = useState<string[]>([])
  const [addLang, setAddLang] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const [rawText, setRawText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const setConfigDirty = useConfigDirty(s => s.setDirty)

  useEffect(() => {
    ipc.readFile('user/portals.yml').then(text => {
      if (!text) return
      setRaw(text)
      setRawText(text)
      const pos = extractPortalKeywords(text, 'positive')
      const neg = extractPortalKeywords(text, 'negative')
      const lang = parseLangBlocklist(text)
      setPositive(pos)
      setNegative(neg)
      setCompanies(parseCompanies(text))
      setLangKeywords(lang)
      setBaselinePositive(pos)
      setBaselineNegative(neg)
      setBaselineLang(lang)
      setBaselineRaw(text)
    })
  }, [])

  // Track dirty per concept inside the Portals tab. Companies edits
  // (toggle / remove / add) update `raw` immediately, so we compare raw
  // against baselineRaw for the company-related dirty flag.
  useEffect(() => {
    setConfigDirty('portals', 'portals-keywords',
      JSON.stringify(positive) !== JSON.stringify(baselinePositive)
        || JSON.stringify(negative) !== JSON.stringify(baselineNegative))
  }, [positive, negative, baselinePositive, baselineNegative, setConfigDirty])
  useEffect(() => {
    setConfigDirty('portals', 'portals-lang',
      JSON.stringify(langKeywords) !== JSON.stringify(baselineLang))
  }, [langKeywords, baselineLang, setConfigDirty])
  useEffect(() => {
    setConfigDirty('portals', 'portals-raw', (raw ?? '') !== baselineRaw)
  }, [raw, baselineRaw, setConfigDirty])
  useEffect(() => () => {
    setConfigDirty('portals', 'portals-keywords', false)
    setConfigDirty('portals', 'portals-lang', false)
    setConfigDirty('portals', 'portals-raw', false)
  }, [setConfigDirty])

  // PortalsTab has one Save button covering all three dirty sources
  // (keywords / lang / raw). Register the same handler under each
  // sourceId so the modal's saveAll picks it up regardless of which
  // section was edited — saveAll dedups internally by walking the dirty
  // set, but since handleSave persists everything, we want all three to
  // resolve to the same one-shot save.
  const registerSaveHandler = useConfigDirty(s => s.registerSaveHandler)
  useEffect(() => {
    registerSaveHandler('portals-keywords', handleSave)
    registerSaveHandler('portals-lang',     handleSave)
    registerSaveHandler('portals-raw',      handleSave)
    return () => {
      registerSaveHandler('portals-keywords', null)
      registerSaveHandler('portals-lang',     null)
      registerSaveHandler('portals-raw',      null)
    }
  })

  const filteredCompanies = useMemo(() => {
    const q = companySearch.toLowerCase()
    return q
      ? companies.filter(c => c.name.toLowerCase().includes(q) || c.notes.toLowerCase().includes(q))
      : companies
  }, [companies, companySearch])

  const enabledCount = companies.filter(c => c.enabled).length

  const toggleCompany = (name: string) => {
    const updated = companies.map(c => c.name === name ? { ...c, enabled: !c.enabled } : c)
    setCompanies(updated)
    if (raw) setRaw(setCompanyEnabled(raw, name, updated.find(c => c.name === name)!.enabled))
  }

  const handleRemoveCompany = (name: string) => {
    setCompanies(prev => prev.filter(c => c.name !== name))
    if (raw) setRaw(removeCompany(raw, name))
  }

  const handleAddCompany = async () => {
    const name = newCompanyName.trim()
    const url = newCompanyUrl.trim()
    if (!name || companies.find(c => c.name === name)) return
    const newEntry: CompanyEntry = { name, enabled: true, notes: '(probing APIs…)', careers_url: url, scan_method: 'unknown' }
    setCompanies(prev => [...prev, newEntry])
    // Append a placeholder entry to portals.yml — the spawn replaces it
    // with the proper config when the probe finishes.
    if (raw) {
      const updated = addCompany(raw, name, url)
      setRaw(updated)
      await ipc.writeFile('user/portals.yml', updated)
    }
    setNewCompanyName('')
    setNewCompanyUrl('')
    setShowAddCompany(false)

    // Spawn Claude to probe Greenhouse / Ashby / Lever / SmartRecruiters /
    // Workday APIs for this company and rewrite the portals.yml block with
    // the right `api:` URL when found, or `scan_method: websearch` with a
    // tailored scan_query when not. Shows up in the Activity tab.
    const id = `add-company-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    const slash = buildCompanyProbePrompt(name, url)
    useSpawnsStore.getState().clear(id)
    useSpawnsStore.getState().start(
      id,
      `Add company: ${name}`,
      'claude',
      claudeArgs(slash, 'sonnet'),
    )
  }

  const addTag = (
    list: string[], setList: React.Dispatch<React.SetStateAction<string[]>>,
    val: string, setInput: React.Dispatch<React.SetStateAction<string>>,
  ) => {
    const v = val.trim()
    if (v && !list.includes(v)) setList(l => [...l, v])
    setInput('')
  }

  const removeTag = (setList: React.Dispatch<React.SetStateAction<string[]>>, val: string) =>
    setList(l => l.filter(x => x !== val))

  const handleSave = async () => {
    if (raw === null) return
    setSaving(true)
    let u = showRaw ? rawText : raw

    if (!showRaw) {
      // Patch keywords
      const kblock = (items: string[]) => items.length ? items.map(i => `    - "${i}"`).join('\n') + '\n' : ''
      u = u.replace(/(  positive:\n?)([\s\S]*?)(?=\n  negative:)/, `$1${kblock(positive)}`)
      u = u.replace(/(  negative:\n?)([\s\S]*?)(?=\n  seniority|\n\n|$)/, `$1${kblock(negative)}`)
      // Patch lang_blocklist
      u = setLangBlocklist(u, langKeywords)
    }

    await ipc.writeFile('user/portals.yml', u)
    setRaw(u)
    setRawText(u)
    // Reset baselines — current state is now the saved state, dirty clears.
    setBaselinePositive(positive)
    setBaselineNegative(negative)
    setBaselineLang(langKeywords)
    setBaselineRaw(u)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  if (raw === null) return <LoadingRows />

  return (
    <div>
      {/* Keywords */}
      <SettingRow title="Must match" description="Job title must contain at least one of these keywords to pass the scan filter.">
        <TagInput tags={positive} onRemove={t => removeTag(setPositive, t)}
          input={addPos} setInput={setAddPos}
          onAdd={() => addTag(positive, setPositive, addPos, setAddPos)}
          color="text-success bg-success/10 border-success/30" className="mt-3" />
      </SettingRow>

      <SettingRow title="Exclude" description="Roles containing any of these keywords are filtered out regardless of positive matches.">
        <TagInput tags={negative} onRemove={t => removeTag(setNegative, t)}
          input={addNeg} setInput={setAddNeg}
          onAdd={() => addTag(negative, setNegative, addNeg, setAddNeg)}
          color="text-danger bg-danger/10 border-danger/30" className="mt-3" />
        {negative.length > 8 && (
          <p className="mt-2 text-micro text-warning">{negative.length} exclusions — review periodically to avoid over-filtering</p>
        )}
      </SettingRow>

      {/* Companies */}
      <SettingRow
        title="Tracked companies"
        description={`${enabledCount} of ${companies.length} active for scanning. Toggle to enable/disable — changes take effect on next scan.`}
      >
        <div className="mt-3 space-y-2">
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border-default bg-bg-elevated">
            <Search size={12} className="text-text-4 shrink-0" />
            <input
              value={companySearch}
              onChange={e => setCompanySearch(e.target.value)}
              placeholder="Filter companies…"
              className="flex-1 bg-transparent outline-none text-label text-text-1 placeholder:text-text-4"
            />
            {companySearch && (
              <button onClick={() => setCompanySearch('')} className="text-text-4 hover:text-text-2"><X size={11} /></button>
            )}
          </div>

          {/* Company list */}
          <div className="border border-border-default rounded-md overflow-hidden max-h-72 overflow-y-auto">
            {filteredCompanies.length === 0 ? (
              <div className="px-4 py-6 text-center text-label text-text-4">No companies match</div>
            ) : (
              filteredCompanies.map((company, i) => (
                <div
                  key={company.name}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 group',
                    i > 0 && 'border-t border-border-default',
                    !company.enabled && 'opacity-50',
                  )}
                >
                  {/* Toggle switch */}
                  <button
                    onClick={() => toggleCompany(company.name)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
                      company.enabled ? 'bg-accent' : 'bg-border-strong',
                    )}
                    title={company.enabled ? 'Disable' : 'Enable'}
                  >
                    <span className={cn(
                      'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
                      company.enabled ? 'translate-x-4' : 'translate-x-0',
                    )} />
                  </button>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Click the name → open the careers page in the
                          system browser. Falls back to plain text if
                          there's no careers_url on the entry. */}
                      {company.careers_url ? (
                        <button
                          onClick={() => ipc.openExternal(company.careers_url)}
                          title={`Open ${company.careers_url}`}
                          className="text-label text-text-1 font-medium truncate hover:text-accent hover:underline underline-offset-2 transition-colors text-left"
                        >
                          {company.name}
                        </button>
                      ) : (
                        <span className="text-label text-text-1 font-medium truncate">{company.name}</span>
                      )}
                      <ScanMethodBadge method={company.scan_method} />
                    </div>
                    {company.notes && (
                      <div className="text-micro text-text-4 truncate mt-0.5">{company.notes}</div>
                    )}
                  </div>

                  {/* Remove */}
                  <button
                    onClick={() => handleRemoveCompany(company.name)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded text-text-4 hover:text-danger transition-all"
                    title="Remove"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Add company */}
          {showAddCompany ? (
            <div className="flex gap-2 mt-1">
              <input
                value={newCompanyName}
                onChange={e => setNewCompanyName(e.target.value)}
                placeholder="Company name"
                className="flex-1 px-3 h-8 bg-bg-elevated border border-border-default focus:border-accent/50 outline-none rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors text-[12px]"
              />
              <input
                value={newCompanyUrl}
                onChange={e => setNewCompanyUrl(e.target.value)}
                placeholder="careers URL"
                className="flex-1 px-3 h-8 bg-bg-elevated border border-border-default focus:border-accent/50 outline-none rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors text-[12px]"
                onKeyDown={e => { if (e.key === 'Enter') handleAddCompany() }}
              />
              <button
                onClick={handleAddCompany}
                disabled={!newCompanyName.trim()}
                className="px-3 h-8 rounded-md bg-accent/20 border border-accent/30 text-accent-text text-label hover:bg-accent/30 disabled:opacity-40 transition-colors text-[12px]"
              >
                Add
              </button>
              <button
                onClick={() => { setShowAddCompany(false); setNewCompanyName(''); setNewCompanyUrl('') }}
                className="px-2 h-8 rounded-md border border-border-default text-text-4 hover:text-text-2 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowAddCompany(true)}
              className="flex items-center gap-1.5 text-label text-text-4 hover:text-text-2 transition-colors"
            >
              <Plus size={12} />
              Add company
            </button>
          )}
        </div>
      </SettingRow>

      {/* Language filter */}
      <SettingRow
        title="Language filter"
        description="Block postings whose title contains these words. Used to filter out non-English listings (e.g. Spanish, Dutch, German job titles)."
      >
        <TagInput
          tags={langKeywords}
          onRemove={t => removeTag(setLangKeywords, t)}
          input={addLang}
          setInput={setAddLang}
          onAdd={() => addTag(langKeywords, setLangKeywords, addLang, setAddLang)}
          color="text-warning bg-warning/10 border-warning/30"
          className="mt-3"
        />
      </SettingRow>

      {/* Advanced */}
      <SettingRow title="Advanced" description="Edit search_queries, seniority_boost, and raw company config directly.">
        <button
          onClick={() => setShowRaw(v => !v)}
          className="mt-3 flex items-center gap-1.5 text-label text-accent hover:opacity-75 transition-opacity"
        >
          <ChevronRight size={13} className={cn('transition-transform duration-200', showRaw && 'rotate-90')} />
          {showRaw ? 'Hide' : 'Edit'} raw portals.yml
        </button>
        {showRaw && (
          <textarea
            value={rawText}
            onChange={e => setRawText(e.target.value)}
            className="mt-3 w-full h-80 px-3 py-2.5 bg-bg-elevated border border-border-default rounded-md font-mono text-[12px] text-text-2 outline-none focus:border-accent/60 resize-none"
            spellCheck={false}
          />
        )}
      </SettingRow>

      <div className="px-6 py-4 flex items-center justify-between border-t border-border-default">
        <p className="text-label text-text-4">
          Saved to <code className="text-accent/70 bg-bg-elevated px-1 py-0.5 rounded text-micro">user/portals.yml</code>
        </p>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-accent/20 border border-accent/30 text-accent-text text-label rounded-md hover:bg-accent/30 disabled:opacity-40 transition-colors"
        >
          {saved ? <Check size={13} /> : null}
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function SettingRow({ title, description, children }: {
  title: string; description: string; children?: React.ReactNode
}) {
  return (
    <div className="px-6 py-5 border-b border-border-default">
      <div className="max-w-2xl">
        <h3 className="text-body text-text-1 font-medium">{title}</h3>
        <p className="text-label text-text-4 mt-0.5 leading-snug">{description}</p>
        {children}
      </div>
    </div>
  )
}

function ScanMethodBadge({ method }: { method: 'api' | 'websearch' | 'unknown' }) {
  if (method === 'api') {
    return (
      <span
        title="Direct API scan — Greenhouse / Ashby / Lever / SmartRecruiters / Workday. Zero-token."
        className="text-[9.5px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-success/35 bg-success/10 text-success shrink-0"
      >
        API
      </span>
    )
  }
  if (method === 'websearch') {
    return (
      <span
        title="Websearch fallback — no public API. Slower, costs WebSearch calls during oferta runs."
        className="text-[9.5px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-warning/35 bg-warning/10 text-warning shrink-0"
      >
        WEB
      </span>
    )
  }
  return (
    <span
      title="Probe pending — the Add Company spawn is still detecting which ATS this company uses."
      className="text-[9.5px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-border-default bg-bg-elevated text-text-4 shrink-0"
    >
      …
    </span>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder: string; type?: string
}) {
  return (
    <div>
      {label && <label className="block text-label text-text-3 mb-1">{label}</label>}
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full px-3 h-9 bg-bg-elevated border border-border-default focus:border-accent/50 focus:outline-none rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors"
      />
    </div>
  )
}

function TagInput({ tags, onRemove, input, setInput, onAdd, color, className }: {
  tags: string[]; onRemove: (t: string) => void
  input: string; setInput: (v: string) => void
  onAdd: () => void; color: string; className?: string
}) {
  return (
    <div className={cn('flex flex-wrap gap-1.5 p-3 bg-bg-elevated border border-border-default rounded-md min-h-[52px]', className)}>
      {tags.map(t => (
        <span key={t} className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded text-label border', color)}>
          {t}
          <button onClick={() => onRemove(t)} className="hover:opacity-70 transition-opacity"><X size={10} /></button>
        </span>
      ))}
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); onAdd() } }}
        placeholder="Type and press Enter…"
        className="flex-1 min-w-24 bg-transparent outline-none text-label text-text-1 placeholder:text-text-4"
      />
    </div>
  )
}

function LoadingRows() {
  return (
    <div className="p-6 space-y-3">
      {[48, 72, 48, 60].map((w, i) => (
        <div key={i} className="shimmer h-3 rounded" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}

function ModelChoice({ label, sub, value, onChange, disabled = false }: {
  label: string
  sub: string
  value: 'sonnet' | 'opus' | 'haiku'
  onChange: (m: 'sonnet' | 'opus' | 'haiku') => void
  disabled?: boolean
}) {
  const options: Array<{ id: 'sonnet' | 'opus' | 'haiku'; name: string; tag: string }> = [
    { id: 'sonnet', name: 'Sonnet', tag: 'cheaper · fast' },
    { id: 'opus',   name: 'Opus',   tag: 'thorough'      },
  ]
  return (
    <div className={cn('flex items-start justify-between gap-6 py-1', disabled && 'opacity-60')}>
      <div className="min-w-0">
        <div className="text-label text-text-1 font-medium">{label}</div>
        <div className="text-[11px] text-text-4 leading-snug mt-0.5">{sub}</div>
      </div>
      <div className="flex rounded-md overflow-hidden border border-border-default shrink-0">
        {options.map(opt => (
          <button
            key={opt.id}
            onClick={() => !disabled && onChange(opt.id)}
            disabled={disabled}
            className={cn(
              'px-3 py-1.5 text-[12px] font-medium transition-colors whitespace-nowrap',
              value === opt.id
                ? 'bg-accent/20 text-accent-text'
                : 'text-text-3 hover:text-text-1 hover:bg-bg-elevated',
              disabled && 'cursor-not-allowed hover:bg-transparent hover:text-text-3',
            )}
            title={disabled ? 'Locked' : opt.tag}
          >
            {opt.name}
          </button>
        ))}
      </div>
    </div>
  )
}
