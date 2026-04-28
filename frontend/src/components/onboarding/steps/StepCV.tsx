'use client'

import { useState } from 'react'
import { FileText, CheckCircle2, Lock } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'

const CV_THRESHOLD = 100  // characters before "Save" enables

export function StepCV({ onComplete }: { onComplete: () => void }) {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState(false)
  const charCount = text.trim().length
  const ready = charCount >= CV_THRESHOLD

  const handleSave = async () => {
    if (!ready) return
    await ipc.writeFile('user/cv.md', text.trim())
    setSaved(true)
    setTimeout(onComplete, 600)
  }

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-[26px] font-semibold text-text-1 leading-tight mb-3">
          Paste your CV
        </h2>
        <p className="text-[14px] text-text-3 leading-relaxed">
          Drop in your CV text — Claude reads it to score offer fit, generate
          tailored versions per application, and ground every report in what
          you actually have. Markdown formatting is welcome but optional.
        </p>
      </div>

      {/* Privacy reassurance */}
      <div className="flex items-start gap-3 rounded-lg bg-bg-elevated/60 border border-border-default p-3.5">
        <Lock size={15} className="text-accent shrink-0 mt-0.5" />
        <p className="text-[12.5px] text-text-3 leading-relaxed">
          Stored only as <code className="font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">user/cv.md</code> in your repo.
          Nothing leaves your machine — Claude reads it locally on each evaluation.
        </p>
      </div>

      <div className="relative">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={`Paste your CV here…\n\nExperience, skills, education, projects.\nMarkdown lists, headings, bold — all welcome.`}
          className="w-full h-72 px-4 py-3 bg-bg-base border border-border-default focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 rounded-lg text-[12.5px] text-text-1 placeholder:text-text-4 resize-none font-mono leading-relaxed transition-all"
          spellCheck={false}
        />
        <div
          className={cn(
            'absolute bottom-3 right-3 px-2 py-0.5 rounded-pill font-mono text-[10.5px] tabular-nums transition-colors',
            ready
              ? 'bg-success/15 text-success border border-success/30'
              : 'bg-bg-elevated/80 text-text-4 border border-border-default',
          )}
        >
          {charCount > 0
            ? (ready ? `${charCount} chars · ready` : `${charCount} / ${CV_THRESHOLD} chars`)
            : `min ${CV_THRESHOLD} chars`}
        </div>
      </div>

      <div className="flex items-center justify-end">
        <button
          onClick={handleSave}
          disabled={!ready || saved}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] text-white rounded-pill transition-all font-medium text-[14px] shadow-[0_2px_10px_rgba(124,92,255,0.25)]"
        >
          {saved ? <CheckCircle2 size={15} /> : <FileText size={15} />}
          {saved ? 'Saved' : 'Save CV'}
        </button>
      </div>
    </div>
  )
}
