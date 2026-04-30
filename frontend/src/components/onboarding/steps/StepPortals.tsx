'use client'

import { useState, useEffect } from 'react'
import { X, CheckCircle2, Loader2, Sparkles } from 'lucide-react'
import { ipc } from '@/lib/ipc'

const POSITIVE_SUGGESTIONS = [
  'analyst', 'data', 'strategy', 'product', 'operations', 'consultant',
  'associate', 'intern', 'graduate', 'business', 'engineer', 'researcher',
]

const NEGATIVE_SUGGESTIONS = [
  'senior', 'lead', 'manager', 'director', 'principal', 'vp', 'staff',
]

export function StepPortals({ onComplete }: { onComplete: () => void }) {
  const [positive, setPositive] = useState<string[]>([])
  const [negative, setNegative] = useState<string[]>([])
  const [addPos, setAddPos] = useState('')
  const [addNeg, setAddNeg] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const load = async () => {
      const raw = await ipc.readFile('user/portals.yml')
      if (!raw) return
      const posSection = raw.match(/title_filter:\s*([\s\S]*?)(?=\n\S|\n#|$)/)?.[1] ?? ''
      const posBlock = posSection.match(/positive:([\s\S]*?)(?=\n\s{2}\w|\n#|$)/)?.[1] ?? ''
      const negBlock = posSection.match(/negative:([\s\S]*?)(?=\n\s{2}\w|\n#|$)/)?.[1] ?? ''
      const extractList = (block: string) =>
        [...block.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?/gm)].map(m => m[1].trim()).filter(Boolean)
      setPositive(extractList(posBlock).slice(0, 20))
      setNegative(extractList(negBlock).slice(0, 10))
    }
    load()
  }, [])

  const addTag = (list: string[], setList: React.Dispatch<React.SetStateAction<string[]>>, val: string) => {
    const v = val.trim().toLowerCase()
    if (v && !list.includes(v)) setList(l => [...l, v])
  }

  const removeTag = (list: string[], setList: React.Dispatch<React.SetStateAction<string[]>>, val: string) =>
    setList(l => l.filter(x => x !== val))

  const canSave = positive.length > 0

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    let raw = await ipc.readFile('user/portals.yml')
    if (!raw || raw.trim().length < 20) {
      raw = `search_templates:\n  roles_default: '"Analyst" OR "Operations" OR "Strategy" OR "Graduate" OR "Intern"'\n\ntitle_filter:\n  positive:\n  negative:\n  seniority_boost:\n    - "Junior"\n    - "Associate"\n    - "Entry Level"\n    - "Analyst"\n    - "Intern"\n\nlang_blocklist: []\n\ntracked_companies: []\nsearch_queries: []\n`
    }
    const buildBlock = (items: string[]) =>
      items.map(i => `    - "${i}"`).join('\n')
    const updated = raw
      .replace(
        /(positive:\n)([\s\S]*?)(?=\n  negative:)/,
        `$1${buildBlock(positive)}\n`
      )
      .replace(
        /(negative:\n)([\s\S]*?)(?=\n  seniority|\n\n|$)/,
        `$1${buildBlock(negative)}\n`
      )
    await ipc.writeFile('user/portals.yml', updated)
    setSaving(false)
    setSaved(true)
    setTimeout(onComplete, 600)
  }

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-[26px] font-semibold text-text-1 leading-tight mb-3">
          Tune your scan filters
        </h2>
        <p className="text-[14px] text-text-3 leading-relaxed">
          When starpath scans portals, it checks each job title against these
          keywords. Anything matching a positive keyword passes; anything
          matching a negative keyword is dropped. Hit Enter or comma to add
          a custom one.
        </p>
      </div>

      <TagSection
        label="Must contain at least one"
        accent="text-success"
        chipColor="text-success bg-success/10 border-success/30"
        tags={positive}
        onRemove={t => removeTag(positive, setPositive, t)}
        input={addPos}
        setInput={setAddPos}
        onAdd={() => { addTag(positive, setPositive, addPos); setAddPos('') }}
        suggestions={POSITIVE_SUGGESTIONS.filter(s => !positive.includes(s))}
        onSuggest={s => setPositive(l => [...l, s])}
      />

      <TagSection
        label="Drop if title contains any"
        accent="text-danger"
        chipColor="text-danger bg-danger/10 border-danger/30"
        tags={negative}
        onRemove={t => removeTag(negative, setNegative, t)}
        input={addNeg}
        setInput={setAddNeg}
        onAdd={() => { addTag(negative, setNegative, addNeg); setAddNeg('') }}
        suggestions={NEGATIVE_SUGGESTIONS.filter(s => !negative.includes(s))}
        onSuggest={s => setNegative(l => [...l, s])}
      />

      <p className="text-[12px] text-text-4 leading-relaxed">
        Company list and tracked portals come pre-configured in <code className="font-mono text-text-3">user/portals.yml</code> —
        edit it directly or from Settings later.
      </p>

      <div className="flex items-center justify-end gap-3 pt-1">
        {!canSave && (
          <p className="text-[12px] text-text-4">Add at least one positive keyword</p>
        )}
        <button
          onClick={handleSave}
          disabled={!canSave || saving || saved}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] text-white rounded-pill transition-all font-medium text-[14px] shadow-pill hover:shadow-pill-hover"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saved && <CheckCircle2 size={15} />}
          {saved ? 'Saved' : saving ? 'Saving…' : 'Save & finish'}
        </button>
      </div>
    </div>
  )
}

function TagSection({
  label, accent, chipColor, tags, onRemove, input, setInput, onAdd,
  suggestions, onSuggest,
}: {
  label: string
  accent: string
  chipColor: string
  tags: string[]
  onRemove: (t: string) => void
  input: string
  setInput: (v: string) => void
  onAdd: () => void
  suggestions: string[]
  onSuggest: (s: string) => void
}) {
  return (
    <div>
      <label className="block text-[12.5px] text-text-2 font-medium mb-2">
        {label}{' '}
        <span className="text-text-4 font-normal">— {tags.length} keyword{tags.length === 1 ? '' : 's'}</span>
      </label>

      {/* Live tag list */}
      <div className="flex flex-wrap gap-1.5 p-3 bg-bg-base border border-border-default rounded-lg min-h-[80px]">
        {tags.map(t => (
          <span
            key={t}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[11.5px] border ${chipColor}`}
          >
            {t}
            <button onClick={() => onRemove(t)} className="hover:opacity-70 transition-opacity" aria-label={`Remove ${t}`}>
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); onAdd() }
          }}
          placeholder={tags.length === 0 ? 'Type a keyword and press Enter…' : 'add another…'}
          className="flex-1 min-w-[140px] bg-transparent outline-none text-[12.5px] text-text-2 placeholder:text-text-4"
        />
      </div>

      {/* Suggestion chips — saves typing for the common ones */}
      {suggestions.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <span className={`text-[10.5px] font-medium inline-flex items-center gap-1 ${accent}`}>
            <Sparkles size={10} />
            Suggestions
          </span>
          {suggestions.slice(0, 8).map(s => (
            <button
              key={s}
              onClick={() => onSuggest(s)}
              className="inline-flex items-center px-2 py-0.5 rounded-pill text-[10.5px] border border-dashed border-border-strong text-text-3 hover:text-accent hover:border-accent/50 hover:bg-accent/5 transition-all"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
