'use client'

import { useEffect, useState } from 'react'
import { Check, X, Plus } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useDataStore } from '@/store/data'
import { useSpawnsStore, claudeArgs } from '@/store/spawns'
import { useAppStore } from '@/store/app'
import { useConfigDirty } from '@/store/configDirty'
import { cn } from '@/lib/utils'

// ─── Reference data ──────────────────────────────────────────────────────────

// 12 most-used currencies. Covers EU + Anglo + APAC + Nordic.
const CURRENCIES = [
  { code: 'EUR', symbol: '€', label: 'Euro' },
  { code: 'USD', symbol: '$', label: 'US Dollar' },
  { code: 'GBP', symbol: '£', label: 'British Pound' },
  { code: 'CHF', symbol: 'CHF', label: 'Swiss Franc' },
  { code: 'CAD', symbol: 'C$', label: 'Canadian Dollar' },
  { code: 'AUD', symbol: 'A$', label: 'Australian Dollar' },
  { code: 'SEK', symbol: 'kr',  label: 'Swedish Krona' },
  { code: 'NOK', symbol: 'kr',  label: 'Norwegian Krone' },
  { code: 'DKK', symbol: 'kr',  label: 'Danish Krone' },
  { code: 'JPY', symbol: '¥',   label: 'Japanese Yen' },
  { code: 'SGD', symbol: 'S$',  label: 'Singapore Dollar' },
  { code: 'INR', symbol: '₹',   label: 'Indian Rupee' },
] as const

const symbolFor = (code: string) =>
  CURRENCIES.find(c => c.code === code)?.symbol ?? code

// Common country codes — the user's location set is EU-heavy + US/CA + UK,
// so this list is curated for that. Extra entries can be added later;
// keeping it short keeps the dropdown scannable.
const COUNTRY_CODES = [
  { code: '+1',   country: 'US / Canada' },
  { code: '+44',  country: 'United Kingdom' },
  { code: '+33',  country: 'France' },
  { code: '+34',  country: 'Spain' },
  { code: '+39',  country: 'Italy' },
  { code: '+49',  country: 'Germany' },
  { code: '+31',  country: 'Netherlands' },
  { code: '+32',  country: 'Belgium' },
  { code: '+41',  country: 'Switzerland' },
  { code: '+43',  country: 'Austria' },
  { code: '+45',  country: 'Denmark' },
  { code: '+46',  country: 'Sweden' },
  { code: '+47',  country: 'Norway' },
  { code: '+351', country: 'Portugal' },
  { code: '+353', country: 'Ireland' },
  { code: '+358', country: 'Finland' },
  { code: '+420', country: 'Czech Republic' },
] as const

const LANGUAGE_LEVELS = ['native', 'fluent', 'professional', 'conversational', 'basic'] as const
type LangLevel = typeof LANGUAGE_LEVELS[number]

interface Language {
  name: string
  level: LangLevel
}

// ─── Form state ──────────────────────────────────────────────────────────────

interface Form {
  full_name: string; email: string
  phoneCC: string; phoneNum: string
  location: string; headline: string
  linkedin: string; portfolio_url: string; github: string
  comp_min: string; comp_max: string; comp_walkaway: string
  comp_currency: string
  comp_flexibility: string
  languages: Language[]
}

const EMPTY_FORM: Form = {
  full_name: '', email: '', phoneCC: '+1', phoneNum: '',
  location: '', headline: '',
  linkedin: '', portfolio_url: '', github: '',
  comp_min: '', comp_max: '', comp_walkaway: '',
  comp_currency: 'EUR', comp_flexibility: '',
  languages: [],
}

// ─── YAML helpers (line-level patches; preserve comments + structure) ────────

const patchScalar = (yaml: string, key: string, val: string): string => {
  const re = new RegExp(`(  ${key}:\\s*)["']?[^"'\\n]*["']?`)
  if (!yaml.match(re)) return yaml
  return yaml.replace(re, `$1"${val}"`)
}

const extractScalar = (yaml: string, key: string): string =>
  yaml.match(new RegExp(`  ${key}:\\s*["']?([^"'\\n]+)["']?`))?.[1]?.trim() ?? ''

// Parse a comma-separated `languages: "English (fluent), Italian (native)"`
// into structured rows. Robust to spacing variations.
const parseLanguages = (yaml: string): Language[] => {
  const raw = extractScalar(yaml, 'languages')
  if (!raw) return []
  return raw.split(',').map(part => {
    const m = part.trim().match(/^([^(]+?)\s*(?:\(([^)]+)\))?$/)
    if (!m) return null
    const name = m[1]?.trim()
    const level = (m[2]?.trim().toLowerCase() ?? 'fluent') as LangLevel
    if (!name) return null
    return { name, level: LANGUAGE_LEVELS.includes(level) ? level : 'fluent' }
  }).filter(Boolean) as Language[]
}

const serializeLanguages = (langs: Language[]): string =>
  langs.map(l => `${l.name} (${l.level})`).join(', ')

// Inserts `languages: ...` under the `candidate:` block if missing.
const patchLanguages = (yaml: string, langs: Language[]): string => {
  const serialized = serializeLanguages(langs)
  if (extractScalar(yaml, 'languages')) {
    return patchScalar(yaml, 'languages', serialized)
  }
  // Insert after the work_permit line (or at end of candidate: block) so
  // it stays adjacent to the other identity fields.
  const re = /(\n  work_permit:[^\n]*)/
  if (yaml.match(re)) {
    return yaml.replace(re, `$1\n  languages: "${serialized}"`)
  }
  // Fallback: append after candidate: block first key
  const candRe = /(\ncandidate:\n(?:  [^\n]+\n)+)/
  if (yaml.match(candRe)) {
    return yaml.replace(candRe, m => `${m.trimEnd()}\n  languages: "${serialized}"\n`)
  }
  return yaml
}

// Format the structured comp fields back into the existing target_range /
// minimum strings so the modes (which still read the legacy strings) stay
// happy. Numbers go in K, e.g. 25000 → "€25K".
const fmtK = (n: number, sym: string) => {
  if (Number.isNaN(n) || n <= 0) return ''
  if (n < 1000) return `${sym}${n}`               // monthly intern bands
  return `${sym}${Math.round(n / 1000)}K`
}

const splitRange = (range: string): { min: string; max: string } => {
  // "€25K-45K" or "€25K - €45K" or "25-45" — extract two numbers.
  const nums = range.match(/[\d.]+/g)
  if (!nums || nums.length < 2) return { min: nums?.[0] ?? '', max: '' }
  // Convert "25K" → "25000" interpretation: if the number is < 1000 but the
  // raw string contained K, multiply by 1000.
  const hasK = /k/i.test(range)
  const toAbs = (s: string) => {
    const n = parseFloat(s)
    if (Number.isNaN(n)) return ''
    return String(hasK && n < 1000 ? Math.round(n * 1000) : Math.round(n))
  }
  return { min: toAbs(nums[0]), max: toAbs(nums[1]) }
}

const splitWalkaway = (s: string): string => {
  const nums = s.match(/[\d.]+/g)
  if (!nums) return ''
  const hasK = /k/i.test(s)
  const n = parseFloat(nums[0])
  if (Number.isNaN(n)) return ''
  return String(hasK && n < 1000 ? Math.round(n * 1000) : Math.round(n))
}

const splitPhone = (raw: string): { cc: string; num: string } => {
  const m = raw.match(/^(\+\d{1,4})\s*(.*)$/)
  if (m) return { cc: m[1], num: m[2].replace(/\s+/g, ' ').trim() }
  return { cc: '+1', num: raw.trim() }
}

// Display formatter — groups digits 3-3-4 (Italy/Spain/etc) for legibility.
const formatNational = (digits: string): string => {
  const d = digits.replace(/\D/g, '')
  if (d.length <= 3) return d
  if (d.length <= 6) return `${d.slice(0, 3)} ${d.slice(3)}`
  if (d.length <= 10) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`
  return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`
}

// ─── Component ───────────────────────────────────────────────────────────────

const SAVE_SPAWN_ID = 'profile-incremental-update'

export function ProfileEditPanel() {
  const refresh = useDataStore(s => s.refresh)
  const repoPath = useAppStore(s => s.repoPath)
  const startSpawn = useSpawnsStore(s => s.start)
  const clearSpawn = useSpawnsStore(s => s.clear)

  const [raw, setRaw] = useState<string | null>(null)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  // Snapshot of the form at last load/save. Used to compute the diff on
  // the next save so the LLM only sees what actually changed.
  const [baseline, setBaseline] = useState<Form>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // ── Load on mount ──
  useEffect(() => {
    if (!repoPath) return
    ipc.readFile('user/profile.yml').then(text => {
      if (!text) return
      setRaw(text)
      const phone = splitPhone(extractScalar(text, 'phone'))
      const range = splitRange(extractScalar(text, 'target_range'))
      const walk  = splitWalkaway(extractScalar(text, 'minimum'))
      const loaded: Form = {
        full_name:        extractScalar(text, 'full_name'),
        email:            extractScalar(text, 'email'),
        phoneCC:          phone.cc,
        phoneNum:         formatNational(phone.num),
        location:         extractScalar(text, 'location'),
        headline:         extractScalar(text, 'headline'),
        linkedin:         extractScalar(text, 'linkedin'),
        portfolio_url:    extractScalar(text, 'portfolio_url'),
        github:           extractScalar(text, 'github'),
        comp_min:         range.min,
        comp_max:         range.max,
        comp_walkaway:    walk,
        comp_currency:    extractScalar(text, 'currency') || 'EUR',
        comp_flexibility: extractScalar(text, 'location_flexibility'),
        languages:        parseLanguages(text),
      }
      setForm(loaded)
      setBaseline(loaded)
    })
  }, [repoPath])

  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm(prev => ({ ...prev, [k]: v }))

  // Emit dirty state into the cross-cutting Configuration store so the
  // ConfigurationView can prompt on tab switches. We use the same
  // diffForms helper that handleSave uses to compute the LLM patch — one
  // source of truth for "did anything change since last save".
  const setDirty = useConfigDirty(s => s.setDirty)
  const registerSaveHandler = useConfigDirty(s => s.registerSaveHandler)
  useEffect(() => {
    setDirty('identity', 'identity-form', diffForms(baseline, form).length > 0)
  }, [baseline, form, setDirty])
  useEffect(() => () => setDirty('identity', 'identity-form', false), [setDirty])

  const handleSave = async () => {
    if (!raw) return
    setSaving(true)
    let u = raw
    u = patchScalar(u, 'full_name', form.full_name)
    u = patchScalar(u, 'email',     form.email)
    if (form.phoneNum.trim()) {
      u = patchScalar(u, 'phone', `${form.phoneCC} ${form.phoneNum.trim()}`)
    }
    u = patchScalar(u, 'location',      form.location)
    u = patchScalar(u, 'headline',      form.headline)
    u = patchScalar(u, 'linkedin',      form.linkedin)
    u = patchScalar(u, 'portfolio_url', form.portfolio_url)
    u = patchScalar(u, 'github',        form.github)
    // Compensation: write back into the legacy string fields so modes that
    // read target_range / minimum continue to work unchanged.
    const sym = symbolFor(form.comp_currency)
    const minN = parseFloat(form.comp_min)
    const maxN = parseFloat(form.comp_max)
    if (!Number.isNaN(minN) && !Number.isNaN(maxN)) {
      u = patchScalar(u, 'target_range', `${fmtK(minN, sym)}-${fmtK(maxN, sym).replace(sym, '')}`)
    }
    const walkN = parseFloat(form.comp_walkaway)
    if (!Number.isNaN(walkN) && walkN > 0) {
      u = patchScalar(u, 'minimum', fmtK(walkN, sym))
    }
    u = patchScalar(u, 'currency', form.comp_currency)
    u = patchScalar(u, 'location_flexibility', form.comp_flexibility)
    u = patchLanguages(u, form.languages)

    await ipc.writeFile('user/profile.yml', u)
    setRaw(u)

    // Diff baseline → form. Only changes get sent to Claude so the
    // incremental update stays minimal (the previous "re-tailor" button
    // ran a full rebuild every time, which the user found too aggressive).
    const diff = diffForms(baseline, form)
    if (diff.length > 0) {
      const slash = buildIncrementalPrompt(diff)
      // Sonnet — structured-edit task; Opus would be overkill for this.
      clearSpawn(SAVE_SPAWN_ID)
      startSpawn(
        SAVE_SPAWN_ID,
        `Profile sync (${diff.length} change${diff.length > 1 ? 's' : ''})`,
        'claude',
        claudeArgs(slash, 'sonnet'),
      )
    }

    setBaseline(form)
    setSaving(false)
    setSavedAt(Date.now())
    setTimeout(() => setSavedAt(null), 2500)
    await refresh()
  }

  // Register handleSave with the configDirty store so the
  // ConfigurationView's "Save and switch" modal button can call it. Re-
  // registering on every render is cheap (Map.set with the same key) and
  // ensures the store always holds the latest closure — which captures
  // the current `form` state.
  useEffect(() => {
    registerSaveHandler('identity-form', handleSave)
    return () => registerSaveHandler('identity-form', null)
  })

  const justSaved = savedAt != null

  if (raw === null) {
    return (
      <div className="rounded-xl bg-bg-panel border border-border-default p-5 space-y-3">
        <div className="shimmer h-3 rounded w-1/3" />
        <div className="shimmer h-3 rounded w-1/2" />
        <div className="shimmer h-3 rounded w-2/5" />
      </div>
    )
  }

  return (
    <div className="rounded-xl bg-bg-panel border border-border-default overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border-default bg-bg-chrome">
        <div>
          <h2 className="text-[14px] font-semibold text-text-1">Edit profile</h2>
          <p className="text-micro text-text-4 mt-0.5">
            Patches <code className="text-accent/70 bg-bg-elevated px-1 rounded">user/profile.yml</code> — comments and structure are preserved.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving || !form.full_name.trim() || !form.email.trim()}
          title="Save changes. If anything changed, a Sonnet run will incrementally update _profile.md and (when relevant) portals.yml — visible in the Activity tab."
          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/20 border border-accent/30 text-accent-text text-label rounded-md hover:bg-accent/30 disabled:opacity-40 transition-colors"
        >
          {justSaved ? <Check size={12} /> : null}
          {saving ? 'Saving…' : justSaved ? 'Saved' : 'Save'}
        </button>
      </div>

      <div className="px-5 py-4 space-y-6">
        {/* Identity */}
        <Section title="Identity" hint="Used in report headers, generated CVs, and outreach drafts.">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="Full name *"   value={form.full_name} onChange={v => set('full_name', v)} placeholder="Jane Smith" />
            <Field label="Email *"       value={form.email}     onChange={v => set('email', v)}     placeholder="you@email.com" type="email" />
            <PhoneField
              cc={form.phoneCC} num={form.phoneNum}
              onChange={(cc, num) => setForm(prev => ({ ...prev, phoneCC: cc, phoneNum: num }))}
            />
            <Field label="Location"      value={form.location}      onChange={v => set('location', v)}      placeholder="City, Country" />
            <Field label="LinkedIn"      value={form.linkedin}      onChange={v => set('linkedin', v)}      placeholder="linkedin.com/in/yourname" />
            <Field label="Portfolio"     value={form.portfolio_url} onChange={v => set('portfolio_url', v)} placeholder="https://yoursite.com" />
            <Field label="GitHub"        value={form.github}        onChange={v => set('github', v)}        placeholder="github.com/yourhandle" />
          </div>
        </Section>

        {/* Headline */}
        <Section title="Headline" hint="One-line professional identity used in CV intros and evaluations. Keep it under 80 characters.">
          <input
            value={form.headline}
            onChange={e => set('headline', e.target.value)}
            placeholder="e.g. Senior Frontend Engineer · 5y product experience"
            className="w-full px-3 h-9 bg-bg-elevated border border-border-default rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors focus:border-accent/50 outline-none"
          />
          {form.headline && (
            <p className={cn('mt-1 text-micro tabular-nums', form.headline.length > 80 ? 'text-warning' : 'text-text-4')}>
              {form.headline.length} / 80
            </p>
          )}
        </Section>

        {/* Compensation */}
        <Section title="Compensation" hint="Used to score comp fit in offer evaluations. Numbers are absolute (e.g. 45000 = €45K/yr).">
          <div className="grid grid-cols-[80px_1fr_1fr_1fr] gap-3 items-end">
            <CurrencySelect value={form.comp_currency} onChange={v => set('comp_currency', v)} />
            <NumberField label="Target min"     value={form.comp_min}      onChange={v => set('comp_min', v)}      placeholder="25000" />
            <NumberField label="Target max"     value={form.comp_max}      onChange={v => set('comp_max', v)}      placeholder="45000" />
            <NumberField label="Walk-away"      value={form.comp_walkaway} onChange={v => set('comp_walkaway', v)} placeholder="15000" />
          </div>
          <div className="mt-3">
            <Field label="Location flexibility" value={form.comp_flexibility} onChange={v => set('comp_flexibility', v)} placeholder="Open to relocation within Europe" />
          </div>
        </Section>

        {/* Languages */}
        <Section title="Languages" hint="Each language with proficiency. Used by scouting/oferta to flag language-locked roles.">
          <LanguagesField
            languages={form.languages}
            onChange={langs => set('languages', langs)}
          />
        </Section>
      </div>
    </div>
  )
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-3 pb-1.5 mb-3 border-b border-border-default/60">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-3">{title}</h3>
        {hint && <p className="text-micro text-text-4 max-w-[420px] text-right truncate" title={hint}>{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <div className="min-w-0">
      {label && <label className="block text-label text-text-3 mb-1">{label}</label>}
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 h-9 bg-bg-elevated border border-border-default rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors focus:border-accent/50 outline-none"
      />
    </div>
  )
}

function NumberField({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div className="min-w-0">
      <label className="block text-label text-text-3 mb-1">{label}</label>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={e => onChange(e.target.value.replace(/[^\d]/g, ''))}
        placeholder={placeholder}
        className="w-full px-3 h-9 bg-bg-elevated border border-border-default rounded-md text-body text-text-1 font-mono tabular-nums placeholder:text-text-4 transition-colors focus:border-accent/50 outline-none"
      />
    </div>
  )
}

function CurrencySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="min-w-0">
      <label className="block text-label text-text-3 mb-1">Currency</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-2 h-9 bg-bg-elevated border border-border-default rounded-md text-body text-text-1 transition-colors focus:border-accent/50 outline-none cursor-pointer"
      >
        {CURRENCIES.map(c => (
          <option key={c.code} value={c.code}>{c.code}</option>
        ))}
      </select>
    </div>
  )
}

function PhoneField({ cc, num, onChange }: {
  cc: string
  num: string
  onChange: (cc: string, num: string) => void
}) {
  return (
    <div className="min-w-0">
      <label className="block text-label text-text-3 mb-1">Phone</label>
      <div className="flex gap-2">
        <select
          value={cc}
          onChange={e => onChange(e.target.value, num)}
          className="px-2 h-9 bg-bg-elevated border border-border-default rounded-md text-body text-text-1 transition-colors focus:border-accent/50 outline-none cursor-pointer font-mono shrink-0"
          style={{ width: 80 }}
        >
          {COUNTRY_CODES.map(c => (
            <option key={c.code} value={c.code}>{c.code}</option>
          ))}
        </select>
        <input
          type="tel"
          inputMode="tel"
          value={num}
          onChange={e => onChange(cc, formatNational(e.target.value))}
          placeholder="123 456 789"
          className="flex-1 min-w-0 px-3 h-9 bg-bg-elevated border border-border-default rounded-md text-body text-text-1 font-mono tabular-nums placeholder:text-text-4 transition-colors focus:border-accent/50 outline-none"
        />
      </div>
    </div>
  )
}

function LanguagesField({ languages, onChange }: {
  languages: Language[]
  onChange: (l: Language[]) => void
}) {
  const [name, setName] = useState('')
  const [level, setLevel] = useState<LangLevel>('fluent')

  const add = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (languages.some(l => l.name.toLowerCase() === trimmed.toLowerCase())) {
      setName('')
      return
    }
    onChange([...languages, { name: trimmed, level }])
    setName('')
    setLevel('fluent')
  }

  const remove = (n: string) => onChange(languages.filter(l => l.name !== n))

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        {languages.length === 0 && (
          <span className="text-micro text-text-4 italic py-1">No languages added yet.</span>
        )}
        {languages.map(l => (
          <span
            key={l.name}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-bg-elevated border border-border-default text-label text-text-2"
          >
            <span className="font-medium text-text-1">{l.name}</span>
            <span className="text-micro text-text-4">({l.level})</span>
            <button
              onClick={() => remove(l.name)}
              aria-label={`Remove ${l.name}`}
              className="ml-0.5 -mr-1 p-0.5 rounded hover:bg-danger/15 hover:text-danger transition-colors"
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="Language (e.g. English, Italian, Spanish)"
          className="flex-1 px-3 h-9 bg-bg-elevated border border-border-default rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors focus:border-accent/50 outline-none"
        />
        <select
          value={level}
          onChange={e => setLevel(e.target.value as LangLevel)}
          className="px-2 h-9 bg-bg-elevated border border-border-default rounded-md text-body text-text-1 transition-colors focus:border-accent/50 outline-none cursor-pointer"
        >
          {LANGUAGE_LEVELS.map(l => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <button
          onClick={add}
          disabled={!name.trim()}
          className="flex items-center gap-1 px-3 h-9 bg-accent/15 border border-accent/30 text-accent-text text-label rounded-md hover:bg-accent/25 disabled:opacity-40 transition-colors"
        >
          <Plus size={12} />
          Add
        </button>
      </div>
    </div>
  )
}

// ─── Diff + LLM prompt ──────────────────────────────────────────────────────
//
// The previous standalone "Re-tailor" button kicked off the full setup
// skill on every click — which rewrote portals.yml and _profile.md from
// scratch. Per the user, that was too aggressive: incremental edits would
// be enough most of the time. This module replaces the button with a
// diff-aware spawn that fires on Save and only when something actually
// changed, with a prompt that tells Claude to make minimal targeted edits.

interface DiffEntry { label: string; before: string; after: string }

function diffForms(base: Form, curr: Form): DiffEntry[] {
  const out: DiffEntry[] = []
  const cmp = (label: string, b: string, c: string) => {
    if ((b ?? '').trim() !== (c ?? '').trim()) out.push({ label, before: b, after: c })
  }
  cmp('full_name', base.full_name, curr.full_name)
  cmp('email',     base.email,     curr.email)
  cmp('phone',     `${base.phoneCC} ${base.phoneNum}`, `${curr.phoneCC} ${curr.phoneNum}`)
  cmp('location',  base.location,  curr.location)
  cmp('headline',  base.headline,  curr.headline)
  cmp('linkedin',  base.linkedin,  curr.linkedin)
  cmp('portfolio_url', base.portfolio_url, curr.portfolio_url)
  cmp('github',    base.github,    curr.github)
  cmp('comp.target_min',  base.comp_min,      curr.comp_min)
  cmp('comp.target_max',  base.comp_max,      curr.comp_max)
  cmp('comp.walk_away',   base.comp_walkaway, curr.comp_walkaway)
  cmp('comp.currency',    base.comp_currency, curr.comp_currency)
  cmp('comp.flexibility', base.comp_flexibility, curr.comp_flexibility)
  // Languages — render as comma-joined for diff readability.
  const baseLangs = serializeLanguages(base.languages)
  const currLangs = serializeLanguages(curr.languages)
  if (baseLangs !== currLangs) out.push({ label: 'languages', before: baseLangs, after: currLangs })
  return out
}

function buildIncrementalPrompt(diff: DiffEntry[]): string {
  const lines = diff
    .map(d => `- ${d.label}: ${d.before ? `"${d.before}"` : '(empty)'} → ${d.after ? `"${d.after}"` : '(empty)'}`)
    .join('\n')
  return [
    'The user just edited user/profile.yml. ONLY these fields changed:',
    '',
    lines,
    '',
    'Make MINIMAL incremental edits to bring the rest of the user-layer files in sync — do NOT regenerate from scratch:',
    '',
    '1. user/_profile.md — narrative may need small touches (e.g., updated comp expectations, new languages mentioned in proof points). Edit ONLY the lines that need to reflect these specific changes; do not rewrite sections that are unrelated. If nothing in _profile.md is materially affected by these changes, leave the file alone.',
    '',
    '2. user/portals.yml — only touch this if a language change affects lang_blocklist (e.g., a language was removed and now non-English postings in that language should be filtered out, or a language was added and an existing block is now wrong). Otherwise leave portals.yml alone.',
    '',
    '3. Do NOT touch user/cv.md, user/article-digest.md, or any system-layer files (modes/, scripts/, batch/).',
    '',
    'Be surgical. The diff is intentionally small; the edit set should be too. If a field changed but no narrative update is warranted, that is the correct answer — do not invent edits.',
  ].join('\n')
}
