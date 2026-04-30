'use client'

import { useEffect, useState } from 'react'
import { FileText, CheckCircle2, Lock, Upload, FileType, AlertTriangle, Loader2 } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useSpawnsStore, claudeArgs } from '@/store/spawns'
import { cn } from '@/lib/utils'

const CV_THRESHOLD = 100  // characters before "Save" enables in paste mode
const CV_PDF_SPAWN_ID = 'onboard-cv-pdf'

export function StepCV({ onComplete }: { onComplete: () => void }) {
  const [mode, setMode] = useState<'paste' | 'upload'>('paste')
  const [text, setText] = useState('')
  const [saved, setSaved] = useState(false)

  const charCount = text.trim().length
  const ready = charCount >= CV_THRESHOLD

  const handleSavePaste = async () => {
    if (!ready) return
    await ipc.writeFile('user/cv.md', text.trim())
    setSaved(true)
    setTimeout(onComplete, 600)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[26px] font-semibold text-text-1 leading-tight mb-3">
          Add your CV
        </h2>
        <p className="text-[14px] text-text-3 leading-relaxed">
          Claude reads your CV to score offer fit, generate tailored versions per
          application, and ground every report in what you actually have. Paste
          markdown text directly, or upload a PDF and Claude converts it.
        </p>
      </div>

      {/* Mode switcher */}
      <div className="inline-flex rounded-md border border-border-default bg-bg-elevated p-0.5">
        {([
          { key: 'paste',  label: 'Paste text', icon: FileText },
          { key: 'upload', label: 'Upload PDF', icon: Upload },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded text-[12.5px] font-medium transition-colors',
              mode === key
                ? 'bg-bg-base text-text-1 shadow-sm'
                : 'text-text-3 hover:text-text-1',
            )}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {/* Privacy reassurance — same for both modes */}
      <div className="flex items-start gap-3 rounded-lg bg-bg-elevated/60 border border-border-default p-3.5">
        <Lock size={15} className="text-accent shrink-0 mt-0.5" />
        <p className="text-[12.5px] text-text-3 leading-relaxed">
          Stored only as <code className="font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">user/cv.md</code> in your repo.
          Nothing leaves your machine — Claude reads it locally on each evaluation.
        </p>
      </div>

      {mode === 'paste' ? (
        <PasteMode
          text={text}
          setText={setText}
          charCount={charCount}
          ready={ready}
          saved={saved}
          onSave={handleSavePaste}
        />
      ) : (
        <UploadMode onComplete={onComplete} />
      )}
    </div>
  )
}

// ─── Paste mode ──────────────────────────────────────────────────────────────

function PasteMode({
  text, setText, charCount, ready, saved, onSave,
}: {
  text: string; setText: (v: string) => void
  charCount: number; ready: boolean; saved: boolean
  onSave: () => void
}) {
  return (
    <>
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
          onClick={onSave}
          disabled={!ready || saved}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] text-white rounded-pill transition-all font-medium text-[14px] shadow-pill hover:shadow-pill-hover"
        >
          {saved ? <CheckCircle2 size={15} /> : <FileText size={15} />}
          {saved ? 'Saved' : 'Save CV'}
        </button>
      </div>
    </>
  )
}

// ─── Upload mode ─────────────────────────────────────────────────────────────

function UploadMode({ onComplete }: { onComplete: () => void }) {
  const [pdfPath, setPdfPath] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const startSpawn = useSpawnsStore(s => s.start)
  const clearSpawn = useSpawnsStore(s => s.clear)
  const spawn = useSpawnsStore(s => s.spawns[CV_PDF_SPAWN_ID])

  const running = spawn?.status === 'running'
  const done    = spawn?.status === 'done'
  const errored = spawn?.status === 'error' || spawn?.status === 'killed'

  // When the spawn finishes successfully, advance the wizard. We deliberately
  // don't auto-advance on partial success — the converter writes user/cv.md
  // directly, so success means the file is there.
  useEffect(() => {
    if (done) {
      const t = setTimeout(onComplete, 800)
      return () => clearTimeout(t)
    }
  }, [done, onComplete])

  const pickFile = async () => {
    const result = await ipc.selectCvPdf()
    if (!result?.path) return
    setPdfPath(result.path)
    setConfirmed(false)
  }

  const startConvert = () => {
    if (!pdfPath) return
    clearSpawn(CV_PDF_SPAWN_ID)
    // Sonnet — this is structured extraction, not deep reasoning. The
    // `@<abspath>` token instructs the Claude CLI to read the file as
    // input; PDF support is built into the Claude CLI / SDK.
    const slash =
      `@${pdfPath} — Convert this PDF CV to clean markdown and write the result to user/cv.md. ` +
      `Preserve every section that's present (Education, Experience, Projects, Technical Skills, Languages, Certifications, Activities). ` +
      `Use # for the candidate name, ## for major sections, ### for sub-entries, regular markdown lists for bullets. ` +
      `Include the contact line right under the name. Do NOT invent content; only transcribe what's in the PDF. ` +
      `Do NOT print any commentary — just write the file and exit.`
    startSpawn(CV_PDF_SPAWN_ID, 'Convert CV PDF → markdown', 'claude', claudeArgs(slash, 'sonnet'))
    setConfirmed(true)
  }

  const fileName = pdfPath ? pdfPath.split('/').pop() : null

  return (
    <div className="space-y-4">
      {!pdfPath && (
        <button
          onClick={pickFile}
          className="w-full flex flex-col items-center justify-center gap-3 py-12 px-6 rounded-xl border-2 border-dashed border-border-default hover:border-accent/50 hover:bg-accent/5 transition-colors group"
        >
          <FileType size={28} className="text-text-4 group-hover:text-accent transition-colors" />
          <div className="text-center">
            <p className="text-[14px] text-text-1 font-medium">Choose PDF</p>
            <p className="text-[12px] text-text-4 mt-1">A standard CV PDF — Claude reads it natively, no OCR needed.</p>
          </div>
        </button>
      )}

      {pdfPath && !confirmed && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-5 space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-warning shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-text-1">Heads up — this costs Claude tokens</p>
              <p className="text-[12.5px] text-text-3 leading-relaxed mt-1.5">
                A typical 2-page CV PDF is ~10–20K tokens (input + Claude's markdown output).
                Cheaper than scoring a single listing, but worth knowing. The cost is on
                your Anthropic / Claude bill, not ours.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 pl-7 min-w-0">
            <FileType size={14} className="text-text-3 shrink-0" />
            <span className="text-[12.5px] text-text-2 font-mono truncate">{fileName}</span>
            <button
              onClick={() => setPdfPath(null)}
              className="ml-auto shrink-0 text-[11px] text-text-4 hover:text-text-2 transition-colors"
            >
              Pick different
            </button>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={() => setPdfPath(null)}
              className="px-3 py-1.5 text-label text-text-2 rounded-md hover:bg-bg-elevated transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={startConvert}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-md text-[12.5px] font-medium transition-colors"
            >
              <Upload size={12} />
              Convert with Claude
            </button>
          </div>
        </div>
      )}

      {confirmed && running && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-5 flex items-center gap-3">
          <Loader2 size={18} className="text-accent animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-text-1">Converting…</p>
            <p className="text-[12px] text-text-3 mt-0.5">
              Claude is reading <span className="font-mono">{fileName}</span> and writing <code className="font-mono text-accent bg-accent/10 px-1 py-0.5 rounded text-[10.5px]">user/cv.md</code>. Live log on the Activity tab.
            </p>
          </div>
        </div>
      )}

      {confirmed && done && (
        <div className="rounded-xl border border-success/30 bg-success/5 p-5 flex items-center gap-3">
          <CheckCircle2 size={18} className="text-success shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-text-1">CV written.</p>
            <p className="text-[12px] text-text-3 mt-0.5">Moving to the next step…</p>
          </div>
        </div>
      )}

      {confirmed && errored && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-5 space-y-3">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-text-1">Conversion didn't finish.</p>
              <p className="text-[12.5px] text-text-3 mt-1">
                Check the Activity tab for the full log. You can try again with the same PDF or switch to paste mode.
              </p>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => { clearSpawn(CV_PDF_SPAWN_ID); setConfirmed(false); setPdfPath(null) }}
              className="px-3 py-1.5 text-label text-text-2 rounded-md hover:bg-bg-elevated transition-colors"
            >
              Pick different file
            </button>
            <button
              onClick={() => { clearSpawn(CV_PDF_SPAWN_ID); startConvert() }}
              className="px-3 py-1.5 text-label text-accent-text bg-accent/15 border border-accent/30 rounded-md hover:bg-accent/25 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
