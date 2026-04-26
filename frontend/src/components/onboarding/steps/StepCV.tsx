'use client'

import { useState } from 'react'
import { FileText, CheckCircle2 } from 'lucide-react'
import { ipc } from '@/lib/ipc'

export function StepCV({ onComplete }: { onComplete: () => void }) {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState(false)

  const canSave = text.trim().length > 100

  const handleSave = async () => {
    if (!canSave) return
    await ipc.writeFile('user/cv.md', text.trim())
    setSaved(true)
    setTimeout(onComplete, 500)
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-section text-text-1 mb-2">Add your CV</h2>
        <p className="text-body text-text-3">
          Paste your CV below. Markdown formatting works, but plain text is fine too.
          This is what Claude uses to write tailored applications and score fit.
        </p>
      </div>

      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Paste your CV here — experience, skills, education, projects…"
        className="w-full h-72 px-3 py-2.5 bg-bg-base border border-border-default focus:border-accent focus:outline-none rounded-md text-body text-text-1 placeholder:text-text-4 resize-none font-mono text-label leading-relaxed transition-colors"
        spellCheck={false}
      />

      <div className="flex items-center justify-between">
        <span className="text-label text-text-4">
          {text.trim().length > 0 ? `${text.trim().length} chars` : 'Min. ~100 characters'}
        </span>
        <button
          onClick={handleSave}
          disabled={!canSave || saved}
          className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 text-white rounded-md transition-all font-medium text-body"
        >
          {saved ? <CheckCircle2 size={15} /> : <FileText size={15} />}
          {saved ? 'Saved!' : 'Save CV'}
        </button>
      </div>
    </div>
  )
}
