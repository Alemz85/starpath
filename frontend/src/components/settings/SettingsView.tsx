'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
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

const patchField = (yaml: string, key: string, val: string): string => {
  const re = new RegExp(`(  ${key}:\\s*)["']?[^"'\\n]*["']?`)
  return yaml.match(re) ? yaml.replace(re, `$1"${val}"`) : yaml
}

const extractField = (yaml: string, key: string): string =>
  yaml.match(new RegExp(`  ${key}:\\s*["']?([^"'\\n]+)["']?`))?.[1]?.trim() ?? ''

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
      return { name, enabled, notes, careers_url }
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
    `    scan_query: 'site:${domain} "Analyst" OR "Operations" OR "Intern"'`,
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

type Tab = 'general' | 'candidate' | 'roles' | 'portals'

const TABS: { key: Tab; label: string }[] = [
  { key: 'general',   label: 'General' },
  { key: 'candidate', label: 'Candidate' },
  { key: 'roles',     label: 'Target Roles' },
  { key: 'portals',   label: 'Portals' },
]

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<Tab>('general')

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar — extends to y=0 with pt-7 clearing the macOS traffic-light zone */}
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Settings</h1>
      </div>

      <div className="flex items-center border-b border-border-default bg-bg-chrome shrink-0 px-2">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={cn(
              'px-4 py-2.5 text-label border-b-2 transition-colors',
              activeTab === key
                ? 'border-accent text-text-1'
                : 'border-transparent text-text-4 hover:text-text-2',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'general'   && <GeneralTab />}
        {activeTab === 'candidate' && <CandidateTab />}
        {activeTab === 'roles'     && <RolesTab />}
        {activeTab === 'portals'   && <PortalsTab />}
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
    { key: 'pipeline',       label: 'Pipeline buttons',       sub: 'Filter to Database · Generate Top Reports · Generate All Reports. Also editable via the Model chip on the Scouting cockpit.' },
    { key: 'tailorCv',       label: 'Tailor CV',              sub: 'Per-listing CV regeneration on the Applying tab (modes/pdf.md).' },
    { key: 'draftApp',       label: 'Draft Application',      sub: 'Per-listing form-fill draft on the Applying tab (modes/apply.md).' },
    { key: 'interviewPrep',  label: 'Prep Interview',         sub: 'Per-listing interview brief generation (modes/interview-prep.md).' },
    { key: 'generateReport', label: 'Generate Report',        sub: 'Promote a Database row to a full per-listing prose report.' },
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
        description="Pick the Claude model used for each category of work. Sonnet is cheaper and fast; Opus is more thorough. Full Scan always uses Sonnet (cheap tool-use)."
      >
        <div className="mt-3 divide-y divide-border-default border border-border-default rounded-md overflow-hidden">
          {MODEL_ROWS.map(row => (
            <div key={row.key} className="px-4 py-3">
              <ModelChoice
                label={row.label}
                sub={row.sub}
                value={models[row.key]}
                onChange={(m) => setModel(row.key, m)}
              />
            </div>
          ))}
          <div className="px-4 py-3 bg-bg-elevated/50">
            <ModelChoice
              label="Full Scan"
              sub="Locked to Sonnet — the scanner just hits Greenhouse / Ashby / Lever APIs, so Opus would be wasted."
              value="sonnet"
              onChange={() => {}}
              disabled
            />
          </div>
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

// ─── Candidate tab ────────────────────────────────────────────────────────────

interface CandidateForm {
  full_name: string; email: string; phone: string; location: string
  linkedin: string; portfolio_url: string; github: string
  headline: string
  comp_target: string; comp_currency: string; comp_minimum: string; comp_flexibility: string
}

function CandidateTab() {
  const [raw, setRaw] = useState<string | null>(null)
  const [form, setForm] = useState<CandidateForm>({
    full_name: '', email: '', phone: '', location: '', linkedin: '',
    portfolio_url: '', github: '', headline: '',
    comp_target: '', comp_currency: 'EUR', comp_minimum: '', comp_flexibility: '',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    ipc.readFile('user/profile.yml').then(text => {
      if (!text) return
      setRaw(text)
      setForm({
        full_name:        extractField(text, 'full_name'),
        email:            extractField(text, 'email'),
        phone:            extractField(text, 'phone'),
        location:         extractField(text, 'location'),
        linkedin:         extractField(text, 'linkedin'),
        portfolio_url:    extractField(text, 'portfolio_url'),
        github:           extractField(text, 'github'),
        headline:         extractField(text, 'headline'),
        comp_target:      extractField(text, 'target_range'),
        comp_currency:    extractField(text, 'currency') || 'EUR',
        comp_minimum:     extractField(text, 'minimum'),
        comp_flexibility: extractField(text, 'location_flexibility'),
      })
    })
  }, [])

  const set = (key: keyof CandidateForm) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm(f => ({ ...f, [key]: e.target.value }))

  const handleSave = async () => {
    if (!raw) return
    setSaving(true)
    let u = raw
    u = patchField(u, 'full_name',          form.full_name)
    u = patchField(u, 'email',               form.email)
    if (form.phone)            u = patchField(u, 'phone',               form.phone)
    if (form.location)         u = patchField(u, 'location',            form.location)
    if (form.linkedin)         u = patchField(u, 'linkedin',            form.linkedin)
    if (form.portfolio_url)    u = patchField(u, 'portfolio_url',       form.portfolio_url)
    if (form.github)           u = patchField(u, 'github',              form.github)
    if (form.headline)         u = patchField(u, 'headline',            form.headline)
    if (form.comp_target)      u = patchField(u, 'target_range',        form.comp_target)
    if (form.comp_currency)    u = patchField(u, 'currency',            form.comp_currency)
    if (form.comp_minimum)     u = patchField(u, 'minimum',             form.comp_minimum)
    if (form.comp_flexibility) u = patchField(u, 'location_flexibility',form.comp_flexibility)
    await ipc.writeFile('user/profile.yml', u)
    setRaw(u)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  if (raw === null) return <LoadingRows />

  return (
    <div>
      <SettingRow title="Identity" description="Used in report headers, generated CVs, and outreach drafts.">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-4">
          <Field label="Full name *"    value={form.full_name}    onChange={set('full_name')}    placeholder="Alessandro Mezzanotte" />
          <Field label="Email *"        value={form.email}         onChange={set('email')}         placeholder="you@email.com" type="email" />
          <Field label="Phone"          value={form.phone}         onChange={set('phone')}         placeholder="+39 xxx xxx xxxx" />
          <Field label="Location"       value={form.location}      onChange={set('location')}      placeholder="Barcelona, Spain" />
          <Field label="LinkedIn"       value={form.linkedin}      onChange={set('linkedin')}      placeholder="linkedin.com/in/yourname" />
          <Field label="Portfolio URL"  value={form.portfolio_url} onChange={set('portfolio_url')} placeholder="https://yoursite.com" />
          <Field label="GitHub"         value={form.github}        onChange={set('github')}        placeholder="github.com/yourhandle" />
        </div>
      </SettingRow>

      <SettingRow title="Headline" description="One-line professional identity used in CV intros and evaluations. Keep it under 80 characters.">
        <div className="mt-3">
          <input
            value={form.headline}
            onChange={set('headline')}
            placeholder="e.g. Analytics & Strategy — CEMS Graduate"
            className="w-full px-3 h-9 bg-bg-elevated border border-border-default focus:border-accent/50 focus:outline-none rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors"
          />
          {form.headline && (
            <p className={cn('mt-1 text-micro tabular-nums', form.headline.length > 80 ? 'text-warning' : 'text-text-4')}>
              {form.headline.length} / 80
            </p>
          )}
        </div>
      </SettingRow>

      <SettingRow title="Compensation" description="Used to score comp fit in offer evaluations. Keep values in the same currency.">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-4">
          <Field label="Target range"         value={form.comp_target}      onChange={set('comp_target')}      placeholder="€45K–65K" />
          <Field label="Currency"             value={form.comp_currency}    onChange={set('comp_currency')}    placeholder="EUR" />
          <Field label="Walk-away floor"      value={form.comp_minimum}     onChange={set('comp_minimum')}     placeholder="€35K" />
          <Field label="Location flexibility" value={form.comp_flexibility} onChange={set('comp_flexibility')} placeholder="Remote preferred, open to hybrid" />
        </div>
      </SettingRow>

      <div className="px-6 py-4 flex items-center justify-between border-t border-border-default">
        <p className="text-label text-text-4">
          Patches <code className="text-accent/70 bg-bg-elevated px-1 py-0.5 rounded text-micro">user/profile.yml</code> — comments and structure are preserved.
        </p>
        <button
          onClick={handleSave}
          disabled={saving || !form.full_name.trim() || !form.email.trim()}
          className="flex items-center gap-2 px-4 py-2 bg-accent/20 border border-accent/30 text-accent-text text-label rounded-md hover:bg-accent/30 disabled:opacity-40 transition-colors"
        >
          {saved ? <Check size={13} /> : null}
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

// ─── Roles tab ────────────────────────────────────────────────────────────────

function RolesTab() {
  const [raw, setRaw] = useState<string | null>(null)
  const [roles, setRoles] = useState<string[]>([])
  const [addInput, setAddInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ipc.readFile('user/profile.yml').then(text => {
      if (!text) return
      setRaw(text)
      setRoles(extractPrimaryRoles(text))
    })
  }, [])

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

// ─── Portals tab ──────────────────────────────────────────────────────────────

function PortalsTab() {
  const [raw, setRaw] = useState<string | null>(null)
  const [positive, setPositive] = useState<string[]>([])
  const [negative, setNegative] = useState<string[]>([])
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

  useEffect(() => {
    ipc.readFile('user/portals.yml').then(text => {
      if (!text) return
      setRaw(text)
      setRawText(text)
      setPositive(extractPortalKeywords(text, 'positive'))
      setNegative(extractPortalKeywords(text, 'negative'))
      setCompanies(parseCompanies(text))
      setLangKeywords(parseLangBlocklist(text))
    })
  }, [])

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

  const handleAddCompany = () => {
    const name = newCompanyName.trim()
    const url = newCompanyUrl.trim()
    if (!name || companies.find(c => c.name === name)) return
    const newEntry: CompanyEntry = { name, enabled: true, notes: '', careers_url: url }
    setCompanies(prev => [...prev, newEntry])
    if (raw) setRaw(addCompany(raw, name, url))
    setNewCompanyName('')
    setNewCompanyUrl('')
    setShowAddCompany(false)
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
                    <div className="text-label text-text-1 font-medium truncate">{company.name}</div>
                    {company.notes && (
                      <div className="text-micro text-text-4 truncate">{company.notes}</div>
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
