'use client'

import { useState, useEffect, useRef, useMemo, useId, useCallback } from 'react'
import { useAppStore } from '@/store/app'
import type { FeatureId } from '@/types'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useSpawnsStore, claudeArgs } from '@/store/spawns'
import { useConfigDirty, type ConfigTab } from '@/store/configDirty'
import { useProfilesStore } from '@/store/profiles'
import { ProfileEditPanel } from '@/components/profile/ProfileEditPanel'
import { ViewTabs, viewTabId, viewPanelId } from '@/components/shared/ViewTabs'
import { UnsavedChangesModal } from '@/components/shared/UnsavedChangesModal'
import { ipc } from '@/lib/ipc'
import { slugValidationHint, formatProfileCounts, profileInitial, describeProfileFailure } from '@/lib/profiles'
import { FolderOpen, Check, RefreshCw, Sparkles, X, Plus, ChevronRight, Search, Trash2, Star } from 'lucide-react'
import { Button, Chip, PageHeader } from '@/components/ui'
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

// Identity / compensation extract+patch helpers live in ProfileEditPanel
// (mounted below as the Identity sub-tab). The helpers here are role-list
// and portals-keyword block parsers used by the Roles / Portals sub-tabs.

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

// Settings hosts every configuration surface as sub-tabs — the app-level
// controls plus the editable user-data forms that used to live in a
// separate Configuration view:
//   General  → repo path, search profiles, model selection, data refresh,
//              workspace tuning. Every control saves immediately, so this
//              tab never carries dirty state.
//   Identity → ProfileEditPanel (full-name / contact / phone / comp /
//              languages — everything that lives under candidate: in
//              user/profile.yml).
//   Roles    → target_roles.primary chips + dream-companies block +
//              target locations (preferred_cities).
//   Portals  → keyword filters + tracked companies + lang_blocklist.
//
// When the active tab has unsaved changes (any of its sub-sections has
// updated state since its last save), switching tabs prompts a confirm
// modal — explicit decision rather than silently dropping edits.

type SettingsTab = 'general' | ConfigTab

const TABS: { key: SettingsTab; label: string; sub: string }[] = [
  { key: 'general',  label: 'General',      sub: 'Repository, profiles, models, and data.' },
  { key: 'identity', label: 'Identity',     sub: 'Name, contact, compensation, languages.' },
  { key: 'roles',    label: 'Target roles', sub: 'Primary archetypes, dream companies, and preferred cities.' },
  { key: 'portals',  label: 'Portals',      sub: 'Title filters, tracked companies, language blocklist.' },
]

const isSettingsTab = (v: string): v is SettingsTab => TABS.some(t => t.key === v)

export function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>('general')
  // pendingTab is set when the user clicks a different tab while the
  // current tab is dirty. The modal asks them to discard or stay.
  const [pendingTab, setPendingTab] = useState<SettingsTab | null>(null)

  // Subscribe to all three dirty sets so the dot appears on whichever tab
  // has unsaved changes — including the inactive ones. General is absent
  // from the store: its controls persist on interaction, so it can never
  // be dirty.
  const identityDirty = useConfigDirty(s => s.identity.size > 0)
  const rolesDirty    = useConfigDirty(s => s.roles.size > 0)
  const portalsDirty  = useConfigDirty(s => s.portals.size > 0)
  const dirtyByTab: Record<SettingsTab, boolean> = {
    general:  false,
    identity: identityDirty,
    roles:    rolesDirty,
    portals:  portalsDirty,
  }
  const isDirty = dirtyByTab[tab]

  const requestSwitch = useCallback((next: SettingsTab) => {
    if (next === tab) return
    if (isDirty) {
      setPendingTab(next)
    } else {
      setTab(next)
    }
  }, [tab, isDirty])

  // Sub-tab requests from navigate() — e.g. a CmdK jump straight to
  // Portals. The payload is one-shot but lingers in the store until the
  // next navigate(), so consume each distinct value exactly once: the ref
  // guard keeps requestSwitch identity changes (tab clicks, dirty flips)
  // from replaying a stale request. Routing through requestSwitch — never
  // setTab directly — means a programmatic jump still hits the dirty-gate.
  const requestedTab = useNavStore(s => s.viewTab)
  const consumedTabRequest = useRef('')
  useEffect(() => {
    if (requestedTab === consumedTabRequest.current) return
    consumedTabRequest.current = requestedTab
    if (isSettingsTab(requestedTab)) requestSwitch(requestedTab)
  }, [requestedTab, requestSwitch])

  const discardAndSwitch = () => {
    if (!pendingTab) return
    // Conditional rendering means the abandoned tab's component will
    // unmount, taking its local form state with it. The store's
    // unmount-cleanup effects clear the dirty flags. So discarding is
    // genuinely "drop the edits" — no further work needed here.
    setTab(pendingTab)
    setPendingTab(null)
  }

  const [savingAll, setSavingAll] = useState(false)
  const saveAndSwitch = async () => {
    if (!pendingTab) return
    setSavingAll(true)
    try {
      // Safe cast: General is never dirty, so a gated switch can only
      // originate from one of the three ConfigTab forms.
      await useConfigDirty.getState().saveAll(tab as ConfigTab)
    } finally {
      setSavingAll(false)
    }
    // After saveAll, each section has cleared its own dirty flag and
    // updated its baseline. We can switch now.
    setTab(pendingTab)
    setPendingTab(null)
  }

  const active = TABS.find(t => t.key === tab) ?? TABS[0]

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Settings" meta={active.sub} />

      <ViewTabs
        tabs={TABS.map(({ key, label }) => ({ key, label, dirty: dirtyByTab[key] }))}
        active={tab}
        onSelect={requestSwitch}
        ariaLabel="Settings sections"
        idPrefix="settings"
      />

      {/* Tab panels — one panel per tab, hidden when not active */}
      <div className="flex-1 overflow-y-auto">
        <div
          role="tabpanel"
          id={viewPanelId('settings', 'general')}
          aria-labelledby={viewTabId('settings', 'general')}
          hidden={tab !== 'general'}
          className="h-full"
        >
          {tab === 'general' && <GeneralTab />}
        </div>
        <div
          role="tabpanel"
          id={viewPanelId('settings', 'identity')}
          aria-labelledby={viewTabId('settings', 'identity')}
          hidden={tab !== 'identity'}
          className="h-full"
        >
          {tab === 'identity' && (
            <div className="max-w-[820px] mx-auto w-full px-5 py-5">
              <ProfileEditPanel />
            </div>
          )}
        </div>
        <div
          role="tabpanel"
          id={viewPanelId('settings', 'roles')}
          aria-labelledby={viewTabId('settings', 'roles')}
          hidden={tab !== 'roles'}
          className="h-full"
        >
          {tab === 'roles' && <RolesTab />}
        </div>
        <div
          role="tabpanel"
          id={viewPanelId('settings', 'portals')}
          aria-labelledby={viewTabId('settings', 'portals')}
          hidden={tab !== 'portals'}
          className="h-full"
        >
          {tab === 'portals' && <PortalsTab />}
        </div>
      </div>

      {pendingTab && (
        <UnsavedChangesModal
          targetLabel={TABS.find(t => t.key === pendingTab)!.label}
          saving={savingAll}
          onSave={saveAndSwitch}
          onDiscard={discardAndSwitch}
          onCancel={() => setPendingTab(null)}
        />
      )}
    </div>
  )
}

// ─── General tab ──────────────────────────────────────────────────────────────

function GeneralTab() {
  const repoPath = useAppStore(s => s.repoPath)
  const setRepoPath = useAppStore(s => s.setRepoPath)
  const models = useAppStore(s => s.models)
  const setModel = useAppStore(s => s.setModel)
  const features = useAppStore(s => s.features)
  const setFeature = useAppStore(s => s.setFeature)
  const resetTailoring = useAppStore(s => s.resetTailoring)
  const refresh = useDataStore(s => s.refresh)
  const [refreshDone, setRefreshDone] = useState(false)
  const [retuneDone, setRetuneDone] = useState(false)

  const MODEL_ROWS: Array<{
    key: 'pipeline' | 'tailorCv' | 'draftApp' | 'interviewPrep' | 'generateReport'
    label: string
    sub: string
  }> = [
    { key: 'pipeline',       label: 'Filter to Database',     sub: 'Score-only run that filters pending URLs and writes scoring rows to data/scouting.md. Also editable via the Model chip on the Scouting cockpit.' },
    { key: 'tailorCv',       label: 'Tailor CV',              sub: 'Per-listing CV regeneration on the Applying tab (modes/pdf.md).' },
    { key: 'draftApp',       label: 'Draft Application',      sub: 'Per-listing form-fill draft on the Applying tab (modes/apply.md).' },
    { key: 'interviewPrep',  label: 'Prep Application',       sub: 'Per-listing interview / application brief generation (modes/interview-prep.md).' },
    { key: 'generateReport', label: 'Generate Report',        sub: 'Full per-listing prose reports — used by both the Reports tab Generate Top 5 button and the per-listing Generate Report action in the Database popover.' },
  ]

  // Optional UI surfaces. Off = the surface disappears everywhere (sidebar,
  // sub-tabs, CmdK, panels, columns); the code and the underlying data files
  // stay, so flipping back On restores it instantly.
  const FEATURE_ROWS: Array<{ key: FeatureId; label: string; sub: string }> = [
    { key: 'todayView',       label: 'Today tab',            sub: 'Cross-pipeline "what should I do next?" cockpit. When off, the app opens on Scouting.' },
    { key: 'outreachView',    label: 'Outreach tab',         sub: 'Outreach tracker plus the Network warm-path sub-tab. data/outreach.md and the outreach CLIs keep working while it\'s off.' },
    { key: 'offersView',      label: 'Offers tab',           sub: 'Weighted offer-comparison view. Worth re-enabling when live offers land.' },
    { key: 'scoreTrendTab',   label: 'Score Trend sub-tab',  sub: 'Re-evaluation trajectory panel under Trends (npm run score-trend still has the numbers).' },
    { key: 'dailyBriefPanel', label: 'Daily brief panel',    sub: 'The daily-brief digest embedded in the Scouting cockpit (npm run brief is unaffected).' },
    { key: 'peerContext',     label: 'Peer context',         sub: 'Peers column in the Database table and the peer-rank card in report slide-overs. Scores are untouched.' },
    { key: 'closedLane',      label: 'Closed applications lane', sub: 'The Rejected/Discarded strip on Applying. Closed rows stay visible in Database and Pipeline.' },
  ]

  const changeRepo = async () => {
    const result = await ipc.selectFolder()
    if (result?.valid) { setRepoPath(result.path); await refresh() }
  }

  const handleRefresh = async (e: React.MouseEvent<HTMLButtonElement>) => {
    await refresh({ resync: e.shiftKey })
    setRefreshDone(true)
    setTimeout(() => setRefreshDone(false), 2000)
  }

  const handleRetune = () => {
    resetTailoring()
    setRetuneDone(true)
    setTimeout(() => setRetuneDone(false), 2000)
  }

  return (
    <div>
      <SettingRow title="Repository" description="The local career-ops folder Claude reads and writes to.">
        <div className="flex items-center gap-2 mt-3">
          <div
            className="flex-1 min-w-0 h-7 leading-7 px-2.5 rounded border border-border-default bg-bg-elevated text-label truncate"
            aria-label="Current repository path"
          >
            <span className={repoPath ? 'font-mono text-text-2' : 'text-text-4'}>
              {repoPath ?? 'Not set'}
            </span>
          </div>
          <Button
            tone="secondary"
            size="sm"
            onClick={changeRepo}
            icon={<FolderOpen size={13} aria-hidden="true" />}
            className="shrink-0"
          >
            Change
          </Button>
        </div>
      </SettingRow>

      <ProfilesSection />

      <SettingRow
        title="Models"
        description="Pick the Claude model used for each category of work. Sonnet is cheaper and fast; Opus is more thorough. Each always runs the latest version your Claude CLI knows."
      >
        <div className="mt-4 space-y-3" role="group" aria-label="Model assignments">
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

      <SettingRow
        title="Features"
        description="Optional surfaces you can switch off to slim the app down. Off means hidden everywhere — nothing is deleted, and switching back On restores the surface instantly."
      >
        <div className="mt-4 space-y-3" role="group" aria-label="Feature switches">
          {FEATURE_ROWS.map(row => (
            <FeatureToggle
              key={row.key}
              label={row.label}
              sub={row.sub}
              value={features[row.key]}
              onChange={(enabled) => setFeature(row.key, enabled)}
            />
          ))}
        </div>
      </SettingRow>

      <SettingRow title="Data" description="Reload all data files from disk if they were modified outside the app.">
        {/* Shift-click forces a full SQLite resync from the markdown/TSV
            sources — useful when debugging cache divergence. Plain click
            just re-reads from the DB (the watcher keeps it current). */}
        <Button
          tone="secondary"
          size="sm"
          onClick={handleRefresh}
          title="Shift-click to force a full SQLite resync"
          icon={refreshDone ? <Check size={13} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          className="mt-3"
        >
          {refreshDone ? 'Done' : 'Refresh data'}
        </Button>
      </SettingRow>

      <SettingRow title="Workspace tuning" description="Re-run Claude to regenerate keyword filters and candidate context from your CV and profile.">
        <Button
          tone="secondary"
          size="sm"
          onClick={handleRetune}
          icon={retuneDone ? <Check size={13} aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
          className="mt-3"
        >
          {retuneDone ? 'Started' : 'Re-tune workspace'}
        </Button>
      </SettingRow>
    </div>
  )
}

// ─── Profiles section ─────────────────────────────────────────────────────────
//
// Switchable search profiles (symlink swap in the repo, managed by
// scripts/profile.mjs). Lists what profile:list reports, switches through the
// same guarded path the sidebar switcher uses, and hosts the create form.
// Pre-migration repos (no profiles/ dir) get a one-line pointer to the CLI
// init — everything else stays hidden until it runs.

function ProfilesSection() {
  const profiles = useProfilesStore(s => s.profiles)
  const loaded = useProfilesStore(s => s.loaded)
  const switching = useProfilesStore(s => s.switching)
  const lastFailure = useProfilesStore(s => s.lastFailure)
  const load = useProfilesStore(s => s.load)
  const switchTo = useProfilesStore(s => s.switchTo)
  const createProfile = useProfilesStore(s => s.createProfile)

  const [slug, setSlug] = useState('')
  const [label, setLabel] = useState('')
  const [from, setFrom] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(false)
  const [createFailure, setCreateFailure] = useState<string[]>([])

  useEffect(() => { void load() }, [load])

  const trimmedSlug = slug.trim()
  const hint = slugValidationHint(trimmedSlug)
  const duplicate = profiles.some(p => p.slug === trimmedSlug)
  const canCreate = !!trimmedSlug && !hint && !duplicate && !creating

  const handleCreate = async () => {
    if (!canCreate) return
    setCreating(true)
    setCreateFailure([])
    const res = await createProfile({
      slug: trimmedSlug,
      label: label.trim() || undefined,
      from: from || undefined,
    })
    setCreating(false)
    if (res.ok) {
      setSlug(''); setLabel(''); setFrom('')
      setCreated(true)
      setTimeout(() => setCreated(false), 2500)
    } else {
      setCreateFailure(describeProfileFailure(res))
    }
  }

  if (!loaded) return null

  return (
    <SettingRow
      title="Profiles"
      description="Switchable search profiles — each keeps its own preferences, scan keywords, trackers, and reports. Exactly one is active; switching swaps what every view reads."
    >
      {profiles.length === 0 ? (
        <p className="mt-3 text-label text-text-3">
          Multi-profile mode isn't initialized. Run{' '}
          <code className="font-mono text-micro text-text-2 bg-bg-elevated px-1 py-0.5 rounded-sm">npm run profile -- init</code>{' '}
          in the repo to move the current search into a named profile — the switcher then appears here and in the sidebar.
        </p>
      ) : (
        <>
          <div className="card mt-3 divide-y divide-border-default overflow-hidden" role="list" aria-label="Profiles">
            {profiles.map(p => (
              <div
                key={p.slug}
                role="listitem"
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <span
                  className="w-5 h-5 rounded-full bg-accent-soft text-accent-text text-micro font-semibold flex items-center justify-center shrink-0"
                  aria-hidden="true"
                >
                  {profileInitial(p)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-body font-medium text-text-1 truncate">{p.label || p.slug}</span>
                    <span className="text-label font-mono text-text-4 shrink-0">{p.slug}</span>
                  </div>
                  <div className="text-label text-text-3 mt-0.5 truncate">
                    {p.created && <>Created {p.created} · </>}
                    {formatProfileCounts(p.counts)}
                  </div>
                </div>
                {p.active ? (
                  <Chip tone="accent" size="sm" className="shrink-0">Active</Chip>
                ) : (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => void switchTo(p.slug)}
                    disabled={!!switching}
                    aria-label={`Switch to ${p.label || p.slug}`}
                    className="shrink-0"
                  >
                    {switching === p.slug ? 'Switching…' : 'Switch'}
                  </Button>
                )}
              </div>
            ))}
          </div>

          {lastFailure && (
            <div role="alert" className="mt-2">
              <p className="text-label font-medium text-danger">Switch to {lastFailure.slug} refused</p>
              {lastFailure.lines.map((line, i) => (
                <p key={i} className="text-label text-danger">{line}</p>
              ))}
            </div>
          )}

          {/* Create — slug is the on-disk directory name; label the display
              name; "copy config from" seeds profile.yml / portals.yml /
              _profile.md from an existing profile. Creating never switches. */}
          <div className="mt-4 space-y-2" role="group" aria-label="Create a profile">
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor="profile-create-slug" className="sr-only">Profile slug</label>
                <input
                  id="profile-create-slug"
                  value={slug}
                  onChange={e => setSlug(e.target.value)}
                  placeholder="slug (e.g. cph-student)"
                  spellCheck={false}
                  className="input font-mono"
                />
              </div>
              <div className="flex-1">
                <label htmlFor="profile-create-label" className="sr-only">Profile label</label>
                <input
                  id="profile-create-label"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="Label (optional)"
                  onKeyDown={e => { if (e.key === 'Enter') void handleCreate() }}
                  className="input"
                />
              </div>
            </div>
            <div className="flex gap-2 items-center">
              <label htmlFor="profile-create-from" className="label shrink-0">Copy config from</label>
              <select
                id="profile-create-from"
                value={from}
                onChange={e => setFrom(e.target.value)}
                className="input flex-1 w-auto min-w-0 px-2 cursor-pointer"
              >
                <option value="">Start empty</option>
                {profiles.map(p => (
                  <option key={p.slug} value={p.slug}>{p.label || p.slug}</option>
                ))}
              </select>
              <Button
                tone="secondary"
                size="sm"
                onClick={() => void handleCreate()}
                disabled={!canCreate}
                aria-busy={creating}
                icon={created ? <Check size={13} aria-hidden="true" /> : undefined}
                className="shrink-0"
              >
                {creating ? 'Creating…' : created ? 'Created' : 'Create profile'}
              </Button>
            </div>
            {(hint || (duplicate && trimmedSlug)) && (
              <p className="text-label text-danger" role="alert">
                {hint || `'${trimmedSlug}' already exists`}
              </p>
            )}
            {createFailure.length > 0 && (
              <div role="alert">
                {createFailure.map((line, i) => (
                  <p key={i} className="text-label text-danger">{line}</p>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </SettingRow>
  )
}


// ─── Roles tab ────────────────────────────────────────────────────────────────
//
// Mounted by the SettingsView root above as the "Target Roles" sub-tab.
// Module-private: nothing outside this file renders it.

function RolesTab() {
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
        <div className="mt-3 flex flex-wrap items-center gap-1.5 min-h-6" role="list" aria-label="Selected role archetypes">
          {roles.length === 0 ? (
            <span className="text-label text-text-4">No roles selected. Pick from the suggestions or browse below.</span>
          ) : (
            roles.map(role => (
              <Chip key={role} role="listitem" tone="accent" size="md">
                {role}
                <ChipControl
                  onClick={() => removeRole(role)}
                  aria-label={`Remove ${role}`}
                  className="-mr-1 text-accent-text/60 hover:text-accent-text hover:bg-accent/15"
                >
                  <X size={11} aria-hidden="true" />
                </ChipControl>
              </Chip>
            ))
          )}
        </div>

        {suggestions.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center gap-3 mb-2">
              <span className="label" aria-hidden="true">Related</span>
              <div className="flex-1 h-px bg-border-default" aria-hidden="true" />
            </div>
            <div className="flex flex-wrap gap-1.5" role="list" aria-label="Suggested related roles">
              {suggestions.map((role, i) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => addRole(role)}
                  aria-label={`Add suggested role: ${role}`}
                  className="suggestion-chip chip chip-md border-dashed border-border-strong bg-transparent text-text-3 hover:border-accent/50 hover:text-accent-text hover:bg-accent-soft transition-colors duration-150 ease-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <Plus size={11} className="shrink-0" aria-hidden="true" />
                  {role}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4">
          <label htmlFor="roles-custom-input" className="sr-only">Add a custom role</label>
          <input
            id="roles-custom-input"
            ref={inputRef}
            value={addInput}
            onChange={e => setAddInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addRole(addInput) } }}
            placeholder="Add a custom role and press Enter…"
            aria-label="Add a custom role — press Enter or comma to confirm"
            className="input"
          />
        </div>
      </SettingRow>

      <SettingRow title="Browse all" description="All archetypes in the suggestion graph. Click any to add or remove.">
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="All role archetypes">
          {ROLE_GRAPH_KEYS.map(role => {
            const selected = roles.includes(role)
            return (
              <button
                key={role}
                type="button"
                onClick={() => selected ? removeRole(role) : addRole(role)}
                aria-pressed={selected}
                className={cn(
                  'chip chip-md transition-colors duration-150 ease-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                  selected
                    ? 'chip-accent hover:bg-accent/15'
                    : 'text-text-3 hover:border-border-strong hover:text-text-1',
                )}
              >
                {selected
                  ? <Check size={11} aria-hidden="true" />
                  : <Plus size={11} className="text-text-4" aria-hidden="true" />}
                {role}
              </button>
            )
          })}
        </div>
      </SettingRow>

      <DreamCompaniesSection rawYaml={raw} />

      <TargetLocationsSection rawYaml={raw} />

      <div className="px-5 py-4 flex items-center justify-between gap-3">
        <p className="text-label text-text-3">
          Saved to <code className="font-mono text-micro text-text-2 bg-bg-elevated px-1 py-0.5 rounded-sm">target_roles.primary</code> in <code className="font-mono text-micro text-text-2 bg-bg-elevated px-1 py-0.5 rounded-sm">user/profile.yml</code>
        </p>
        <Button
          tone="primary"
          size="sm"
          onClick={handleSave}
          disabled={saving || roles.length === 0}
          aria-busy={saving}
          aria-label={saving ? 'Saving roles…' : saved ? 'Roles saved' : 'Save roles'}
          icon={saved ? <Check size={13} aria-hidden="true" /> : undefined}
          className="shrink-0"
        >
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save roles'}
        </Button>
      </div>
    </div>
  )
}

// ─── Dream companies section (lives under RolesTab) ──────────────────────────
//
// The dream-companies block in profile.yml is structured (each entry has
// name + functions[] + priority + note). In the Settings UI we only edit
// the names — anything richer can be hand-edited in the YAML.
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
      <div className="mt-3 flex flex-wrap items-center gap-1.5 min-h-6" role="list" aria-label="Dream companies">
        {names.length === 0 ? (
          <span className="text-label text-text-4">No dream companies yet. Add the brands you'd most want to work for.</span>
        ) : (
          names.map(n => (
            <Chip
              key={n}
              role="listitem"
              size="md"
              icon={<Star size={12} className="text-accent-text shrink-0" aria-hidden="true" />}
            >
              {n}
              <ChipControl onClick={() => remove(n)} aria-label={`Remove ${n}`} className="-mr-1">
                <X size={11} aria-hidden="true" />
              </ChipControl>
            </Chip>
          ))
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <label htmlFor="dream-company-input" className="sr-only">Add a dream company</label>
        <input
          id="dream-company-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
          placeholder="Add a company (e.g. Stripe, Datadog) and press Enter…"
          aria-label="Add a dream company — press Enter or comma to confirm"
          className="input flex-1"
        />
        <Button
          tone="secondary"
          size="sm"
          onClick={handleSave}
          disabled={saving || !dirty}
          aria-busy={saving}
          aria-label={saving ? 'Saving dream companies…' : savedAt ? 'Dream companies saved' : 'Save dream companies'}
          icon={savedAt ? <Check size={13} aria-hidden="true" /> : undefined}
          className="shrink-0"
        >
          {saving ? 'Saving…' : savedAt ? 'Saved' : 'Save'}
        </Button>
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
      <div className="mt-3 flex flex-wrap items-center gap-1.5 min-h-6" role="list" aria-label="Target cities in priority order">
        {cities.length === 0 ? (
          <span className="text-label text-text-4">No target locations yet. Add the cities you'd actually relocate to.</span>
        ) : (
          cities.map((c, i) => (
            <Chip key={c} role="listitem" size="md">
              <span className="text-text-4" aria-label={`Priority ${i + 1}`}>#{i + 1}</span>
              {c}
              <span className="inline-flex items-center -mr-1">
                <ChipControl
                  onClick={() => move(c, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${c} up in priority`}
                  aria-disabled={i === 0}
                >
                  <ChevronRight size={11} className="-rotate-90" aria-hidden="true" />
                </ChipControl>
                <ChipControl
                  onClick={() => move(c, 1)}
                  disabled={i === cities.length - 1}
                  aria-label={`Move ${c} down in priority`}
                  aria-disabled={i === cities.length - 1}
                >
                  <ChevronRight size={11} className="rotate-90" aria-hidden="true" />
                </ChipControl>
                <ChipControl onClick={() => remove(c)} aria-label={`Remove ${c}`}>
                  <X size={11} aria-hidden="true" />
                </ChipControl>
              </span>
            </Chip>
          ))
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <label htmlFor="target-location-input" className="sr-only">Add a target city</label>
        <input
          id="target-location-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
          placeholder="Add a city (e.g. Dublin, Barcelona, Berlin) and press Enter…"
          aria-label="Add a target city — press Enter or comma to confirm"
          className="input flex-1"
        />
        <Button
          tone="secondary"
          size="sm"
          onClick={handleSave}
          disabled={saving || !dirty}
          aria-busy={saving}
          aria-label={saving ? 'Saving target locations…' : savedAt ? 'Target locations saved' : 'Save target locations'}
          icon={savedAt ? <Check size={13} aria-hidden="true" /> : undefined}
          className="shrink-0"
        >
          {saving ? 'Saving…' : savedAt ? 'Saved' : 'Save'}
        </Button>
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
//
// Mounted by the SettingsView root above as the "Portals" sub-tab.
// Module-private: nothing outside this file renders it.

function PortalsTab() {
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
          className="mt-3"
          aria-label="Must-match keywords" />
      </SettingRow>

      <SettingRow title="Exclude" description="Roles containing any of these keywords are filtered out regardless of positive matches.">
        <TagInput tags={negative} onRemove={t => removeTag(setNegative, t)}
          input={addNeg} setInput={setAddNeg}
          onAdd={() => addTag(negative, setNegative, addNeg, setAddNeg)}
          className="mt-3"
          aria-label="Exclude keywords" />
        {negative.length > 8 && (
          <p className="mt-2 text-label text-warning-text" role="alert">{negative.length} exclusions. Review them periodically to avoid over-filtering.</p>
        )}
      </SettingRow>

      {/* Companies */}
      <SettingRow
        title="Tracked companies"
        description={`${enabledCount} of ${companies.length} active for scanning. Toggle to enable/disable — changes take effect on next scan.`}
      >
        <div className="mt-3 space-y-2">
          {/* Search */}
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-4 pointer-events-none" aria-hidden="true" />
            <label htmlFor="company-search" className="sr-only">Filter companies</label>
            <input
              id="company-search"
              value={companySearch}
              onChange={e => setCompanySearch(e.target.value)}
              placeholder="Filter companies…"
              className="input pl-8 pr-9"
            />
            {companySearch && (
              <Button
                tone="ghost"
                size="xs"
                iconOnly
                onClick={() => setCompanySearch('')}
                aria-label="Clear company filter"
                icon={<X size={12} aria-hidden="true" />}
                className="absolute right-1 top-1/2 -translate-y-1/2"
              />
            )}
          </div>

          {/* Company list */}
          <div
            className="card divide-y divide-border-default overflow-hidden max-h-72 overflow-y-auto"
            role="list"
            aria-label="Tracked companies"
          >
            {filteredCompanies.length === 0 ? (
              <div className="px-4 py-6 text-center text-label text-text-4">No companies match</div>
            ) : (
              filteredCompanies.map(company => (
                <div
                  key={company.name}
                  role="listitem"
                  className={cn(
                    'flex items-center gap-3 px-3 h-10 group',
                    !company.enabled && 'opacity-50',
                  )}
                >
                  {/* Toggle switch */}
                  <button
                    role="switch"
                    aria-checked={company.enabled}
                    aria-label={`${company.enabled ? 'Disable' : 'Enable'} scanning for ${company.name}`}
                    onClick={() => toggleCompany(company.name)}
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-quart focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      company.enabled ? 'bg-accent' : 'bg-border-strong',
                    )}
                  >
                    <span className={cn(
                      'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
                      company.enabled ? 'translate-x-4' : 'translate-x-0',
                    )} aria-hidden="true" />
                  </button>

                  {/* Info — name, scan method and notes on one 40px line;
                      the full notes ride on the title. */}
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    {/* Click the name → open the careers page in the
                        system browser. Falls back to plain text if
                        there's no careers_url on the entry. */}
                    {company.careers_url ? (
                      <button
                        type="button"
                        onClick={() => ipc.openExternal(company.careers_url)}
                        aria-label={`Open ${company.name} careers page`}
                        title={company.careers_url}
                        className="text-body font-medium text-text-1 truncate max-w-[45%] shrink-0 hover:text-accent-text hover:underline underline-offset-2 transition-colors text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        {company.name}
                      </button>
                    ) : (
                      <span className="text-body font-medium text-text-1 truncate max-w-[45%] shrink-0">{company.name}</span>
                    )}
                    <ScanMethodBadge method={company.scan_method} />
                    {company.notes && (
                      <span className="text-label text-text-3 truncate min-w-0" title={company.notes}>{company.notes}</span>
                    )}
                  </div>

                  {/* Remove */}
                  <Button
                    tone="ghost"
                    size="xs"
                    iconOnly
                    onClick={() => handleRemoveCompany(company.name)}
                    aria-label={`Remove ${company.name}`}
                    icon={<Trash2 size={13} aria-hidden="true" />}
                    className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger"
                  />
                </div>
              ))
            )}
          </div>

          {/* Add company */}
          {showAddCompany ? (
            <div className="flex items-center gap-2 pt-1" role="group" aria-label="Add a new company">
              <label htmlFor="new-company-name" className="sr-only">Company name</label>
              <input
                id="new-company-name"
                value={newCompanyName}
                onChange={e => setNewCompanyName(e.target.value)}
                placeholder="Company name"
                className="input flex-1"
              />
              <label htmlFor="new-company-url" className="sr-only">Careers page URL</label>
              <input
                id="new-company-url"
                value={newCompanyUrl}
                onChange={e => setNewCompanyUrl(e.target.value)}
                placeholder="Careers URL"
                className="input flex-1"
                onKeyDown={e => { if (e.key === 'Enter') handleAddCompany() }}
              />
              <Button
                tone="secondary"
                size="sm"
                onClick={handleAddCompany}
                disabled={!newCompanyName.trim()}
                className="shrink-0"
              >
                Add
              </Button>
              <Button
                tone="ghost"
                size="xs"
                iconOnly
                onClick={() => { setShowAddCompany(false); setNewCompanyName(''); setNewCompanyUrl('') }}
                aria-label="Cancel adding company"
                icon={<X size={13} aria-hidden="true" />}
                className="shrink-0"
              />
            </div>
          ) : (
            <Button
              tone="ghost"
              size="xs"
              onClick={() => setShowAddCompany(true)}
              icon={<Plus size={13} aria-hidden="true" />}
              className="-ml-2"
            >
              Add company
            </Button>
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
          className="mt-3"
          aria-label="Language blocklist keywords"
        />
      </SettingRow>

      {/* Advanced */}
      <SettingRow title="Advanced" description="Edit search_queries, seniority_boost, and raw company config directly.">
        <Button
          tone="ghost"
          size="xs"
          onClick={() => setShowRaw(v => !v)}
          aria-expanded={showRaw}
          aria-controls="portals-raw-editor"
          icon={<ChevronRight size={13} className={cn('transition-transform duration-200 ease-quart', showRaw && 'rotate-90')} aria-hidden="true" />}
          className="mt-3 -ml-2"
        >
          {showRaw ? 'Hide' : 'Edit'} raw portals.yml
        </Button>
        {showRaw && (
          <>
            <label htmlFor="portals-raw-editor" className="sr-only">Raw portals.yml content</label>
            <textarea
              id="portals-raw-editor"
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              className="input mt-3 h-80 py-2 font-mono text-label text-text-2 resize-none"
              spellCheck={false}
            />
          </>
        )}
      </SettingRow>

      <div className="px-5 py-4 flex items-center justify-between gap-3">
        <p className="text-label text-text-3">
          Saved to <code className="font-mono text-micro text-text-2 bg-bg-elevated px-1 py-0.5 rounded-sm">user/portals.yml</code>
        </p>
        <Button
          tone="primary"
          size="sm"
          onClick={handleSave}
          disabled={saving}
          aria-busy={saving}
          aria-label={saving ? 'Saving portals…' : saved ? 'Portals saved' : 'Save portals'}
          icon={saved ? <Check size={13} aria-hidden="true" /> : undefined}
          className="shrink-0"
        >
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function SettingRow({ title, description, children }: {
  title: string; description: string; children?: React.ReactNode
}) {
  const headingId = useId()
  const descId = useId()
  return (
    <div
      className="px-5 py-5 border-b border-border-default"
      role="group"
      aria-labelledby={headingId}
      aria-describedby={descId}
    >
      <div className="max-w-2xl">
        <h3 id={headingId} className="text-section text-text-1">{title}</h3>
        <p id={descId} className="text-label text-text-3 mt-0.5">{description}</p>
        {children}
      </div>
    </div>
  )
}

// Scan method is a property of the entry, not a state — neutral chip.
function ScanMethodBadge({ method }: { method: 'api' | 'websearch' | 'unknown' }) {
  if (method === 'api') {
    return (
      <Chip
        size="sm"
        title="Direct API scan — Greenhouse / Ashby / Lever / SmartRecruiters / Workday. Zero-token."
        className="shrink-0"
      >
        API
      </Chip>
    )
  }
  if (method === 'websearch') {
    return (
      <Chip
        size="sm"
        title="Websearch fallback — no public API. Slower, costs WebSearch calls during evaluation runs."
        className="shrink-0"
      >
        Web
      </Chip>
    )
  }
  return (
    <Chip
      size="sm"
      title="Probe pending — the Add Company spawn is still detecting which ATS this company uses."
      className="shrink-0"
    >
      …
    </Chip>
  )
}

// 16px ghost control inside a chip (remove / reorder). Icon-only: the
// caller supplies the accessible name and any aria-disabled.
function ChipControl({ className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn('btn btn-ghost h-4 w-4 px-0 rounded-sm text-text-4 hover:bg-bg-panel', className)}
    >
      {children}
    </button>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder: string; type?: string
}) {
  const inputId = useId()
  return (
    <div>
      {label && <label htmlFor={inputId} className="label block mb-1">{label}</label>}
      <input
        id={inputId}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="input"
      />
    </div>
  )
}

// Keyword list editor. Every list renders neutral chips — the section title
// says whether it includes or excludes; a keyword list is not a state.
function TagInput({ tags, onRemove, input, setInput, onAdd, className, 'aria-label': ariaLabel }: {
  tags: string[]; onRemove: (t: string) => void
  input: string; setInput: (v: string) => void
  onAdd: () => void; className?: string
  'aria-label'?: string
}) {
  const inputId = useId()
  const label = ariaLabel ?? 'Tag list'
  return (
    <div
      className={cn(
        'card p-2.5 flex flex-wrap items-center gap-1.5 min-h-[46px] transition-colors duration-150',
        'focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20',
        className,
      )}
      role="group"
      aria-label={label}
    >
      {tags.map(t => (
        <Chip key={t} size="md">
          {t}
          <ChipControl onClick={() => onRemove(t)} aria-label={`Remove ${t}`} className="-mr-1">
            <X size={11} aria-hidden="true" />
          </ChipControl>
        </Chip>
      ))}
      <label htmlFor={inputId} className="sr-only">Add a keyword — press Enter or comma to confirm</label>
      <input
        id={inputId}
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); onAdd() } }}
        placeholder="Type and press Enter…"
        className="flex-1 min-w-24 h-6 px-1 bg-transparent outline-none text-body text-text-1 placeholder:text-text-4"
      />
    </div>
  )
}

function LoadingRows() {
  return (
    <div className="p-5 space-y-3">
      {[48, 72, 48, 60].map((w, i) => (
        <div key={i} className="shimmer h-3 rounded" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}

// On/Off pair for a deactivatable feature — same row anatomy and segmented
// control as ModelChoice so the General tab reads as one system.
function FeatureToggle({ label, sub, value, onChange }: {
  label: string
  sub: string
  value: boolean
  onChange: (enabled: boolean) => void
}) {
  const descId = useId()
  const options: Array<{ id: boolean; name: string }> = [
    { id: true,  name: 'On'  },
    { id: false, name: 'Off' },
  ]
  return (
    <div className="flex items-start justify-between gap-6 py-1">
      <div className="min-w-0" id={descId}>
        <div className="text-body font-medium text-text-1">{label}</div>
        <div className="text-label text-text-3 mt-0.5">{sub}</div>
      </div>
      <div
        className="flex rounded border border-border-default overflow-hidden divide-x divide-border-default shrink-0"
        role="group"
        aria-label={label}
        aria-describedby={descId}
      >
        {options.map(opt => (
          <button
            key={String(opt.id)}
            type="button"
            onClick={() => onChange(opt.id)}
            aria-pressed={value === opt.id}
            className={cn(
              'btn btn-xs rounded-none focus-visible:ring-inset',
              value === opt.id ? 'btn-tinted' : 'btn-ghost',
            )}
          >
            {opt.name}
          </button>
        ))}
      </div>
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
  const descId = useId()
  const options: Array<{ id: 'sonnet' | 'opus' | 'haiku'; name: string; tag: string }> = [
    { id: 'sonnet', name: 'Sonnet', tag: 'cheaper · fast' },
    { id: 'opus',   name: 'Opus',   tag: 'thorough'      },
  ]
  return (
    <div className={cn('flex items-start justify-between gap-6 py-1', disabled && 'opacity-60')}>
      <div className="min-w-0" id={descId}>
        <div className="text-body font-medium text-text-1">{label}</div>
        <div className="text-label text-text-3 mt-0.5">{sub}</div>
      </div>
      <div
        className="flex rounded border border-border-default overflow-hidden divide-x divide-border-default shrink-0"
        role="group"
        aria-label={`Model for ${label}`}
        aria-describedby={descId}
      >
        {options.map(opt => (
          <button
            key={opt.id}
            type="button"
            onClick={() => !disabled && onChange(opt.id)}
            disabled={disabled}
            aria-pressed={value === opt.id}
            title={disabled ? 'Locked' : opt.tag}
            className={cn(
              'btn btn-xs rounded-none focus-visible:ring-inset',
              value === opt.id ? 'btn-tinted' : 'btn-ghost',
            )}
          >
            {opt.name}
          </button>
        ))}
      </div>
    </div>
  )
}
