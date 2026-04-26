'use client'

import { useState, useEffect } from 'react'
import { X, Plus, CheckCircle2 } from 'lucide-react'
import { ipc } from '@/lib/ipc'

export function StepPortals({ onComplete }: { onComplete: () => void }) {
  const [positive, setPositive] = useState<string[]>([])
  const [negative, setNegative] = useState<string[]>([])
  const [addPos, setAddPos] = useState('')
  const [addNeg, setAddNeg] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Load from user/portals.yml or example
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
    const v = val.trim()
    if (v && !list.includes(v)) setList(l => [...l, v])
  }

  const removeTag = (list: string[], setList: React.Dispatch<React.SetStateAction<string[]>>, val: string) =>
    setList(l => l.filter(x => x !== val))

  const canSave = positive.length > 0

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)

    let raw = await ipc.readFile('user/portals.yml')

    // If portals.yml doesn't exist yet, create a minimal scaffold
    if (!raw || raw.trim().length < 20) {
      raw = `title_filter:\n  positive:\n  negative:\n  seniority_boost:\n    - "Junior"\n    - "Associate"\n    - "Entry Level"\n    - "Analyst"\n    - "Intern"\n\nlang_blocklist: []\n\ntracked_companies: []\nsearch_queries: []\n`
    }

    // Build new positive/negative blocks
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
    setTimeout(onComplete, 500)
  }

  const TagList = ({
    tags, onRemove, input, setInput, onAdd, color,
  }: {
    tags: string[]
    onRemove: (t: string) => void
    input: string
    setInput: (v: string) => void
    onAdd: () => void
    color: string
  }) => (
    <div className="flex flex-wrap gap-1.5 p-3 bg-bg-base border border-border-default rounded-md min-h-[80px]">
      {tags.map(t => (
        <span
          key={t}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-label border ${color}`}
        >
          {t}
          <button onClick={() => onRemove(t)} className="hover:opacity-70 transition-opacity">
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
        placeholder="Add keyword…"
        className="flex-1 min-w-20 bg-transparent outline-none text-label text-text-2 placeholder:text-text-4"
      />
    </div>
  )

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-section text-text-1 mb-2">Configure portals</h2>
        <p className="text-body text-text-3">
          Set the keywords that filter job titles when scanning. Press Enter or comma to add a tag.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-label text-text-2 mb-1.5">
            Must match (any) <span className="text-text-4">— role title contains one of these</span>
          </label>
          <TagList
            tags={positive}
            onRemove={t => removeTag(positive, setPositive, t)}
            input={addPos}
            setInput={setAddPos}
            onAdd={() => { addTag(positive, setPositive, addPos); setAddPos('') }}
            color="text-success bg-success/10 border-success/30"
          />
        </div>

        <div>
          <label className="block text-label text-text-2 mb-1.5">
            Exclude (any) <span className="text-text-4">— filter out roles containing these</span>
          </label>
          <TagList
            tags={negative}
            onRemove={t => removeTag(negative, setNegative, t)}
            input={addNeg}
            setInput={setAddNeg}
            onAdd={() => { addTag(negative, setNegative, addNeg); setAddNeg('') }}
            color="text-danger bg-danger/10 border-danger/30"
          />
        </div>
      </div>

      <p className="text-label text-text-4">
        Company list and scan methods are pre-configured in user/portals.yml — you can edit them from Settings later.
      </p>

      <div className="flex items-center justify-end gap-3 pt-1">
        {!canSave && (
          <p className="text-label text-text-4">Add at least one keyword to continue</p>
        )}
        <button
          onClick={handleSave}
          disabled={!canSave || saving || saved}
          className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 text-white rounded-md transition-all font-medium text-body"
        >
          {saved ? <CheckCircle2 size={15} /> : null}
          {saved ? 'Saved!' : saving ? 'Saving…' : 'Save & finish'}
        </button>
      </div>
    </div>
  )
}
