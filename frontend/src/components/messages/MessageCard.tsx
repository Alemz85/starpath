'use client'

import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Briefcase, Check, ExternalLink, File, FileText, RotateCcw, X } from 'lucide-react'
import { Button, Chip, type ChipTone } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  KIND_LABEL, SOURCE_LABEL, linkLabel, relativeTime,
  type AgentMessage, type MessageKind, type MessageLink, type MessageStatus,
} from '@/lib/messages'

// One message. Open: kind chip, source and age, title, the markdown body, its
// links, then Resolve (with an optional note) / Dismiss. Closed: the same card
// collapsed to one row (status, title, when, note) that expands on click and
// can be reopened.

const KIND_TONE: Record<MessageKind, ChipTone> = {
  approval:   'accent',   // needs the user: the "act now" colour
  alert:      'danger',   // something failed or is stuck: a state
  suggestion: 'neutral',
  fyi:        'muted',
}

const LINK_ICON = { report: FileText, application: Briefcase, url: ExternalLink, file: File } as const

interface MessageCardProps {
  message: AgentMessage
  canWrite: boolean
  readOnlyTitle?: string
  onSetStatus: (id: string, status: MessageStatus, note?: string) => Promise<string | null>
  onOpenLink: (link: MessageLink) => void
}

export function MessageCard({ message: m, canWrite, readOnlyTitle, onSetStatus, onOpenLink }: MessageCardProps) {
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<MessageStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const open = m.status === 'open'

  const act = async (status: MessageStatus, withNote?: string) => {
    setBusy(status)
    setError(null)
    const err = await onSetStatus(m.id, status, withNote)
    setBusy(null)
    if (err) setError(err)
    else { setNoting(false); setNote('') }
  }

  if (!open && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full flex items-center gap-3 px-4 h-11 text-left border-b border-border-default/50 last:border-b-0 hover:bg-bg-elevated transition-colors"
      >
        <Chip tone={m.status === 'resolved' ? 'success' : 'muted'} pill>
          {m.status === 'resolved' ? 'Resolved' : 'Dismissed'}
        </Chip>
        <span className="text-body text-text-2 truncate min-w-0 flex-1">{m.title}</span>
        {m.resolution_note && <span className="text-label text-text-3 truncate max-w-[32ch]" title={m.resolution_note}>{m.resolution_note}</span>}
        <span className="text-label text-text-4 shrink-0" title={m.resolved_at ?? ''}>{relativeTime(m.resolved_at)}</span>
      </button>
    )
  }

  return (
    <article
      className={cn(open ? 'card p-4' : 'px-4 py-4 border-b border-border-default/50 last:border-b-0')}
      aria-labelledby={`msg-${m.id}-title`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Chip tone={KIND_TONE[m.kind]} pill>{KIND_LABEL[m.kind]}</Chip>
        <span className="text-label text-text-3 truncate">
          {SOURCE_LABEL[m.source]} · <span title={new Date(m.created_at).toLocaleString()}>{relativeTime(m.created_at)}</span>
        </span>
        {!open && (
          <span className="ml-auto text-label text-text-3 shrink-0">
            {m.status === 'resolved' ? 'Resolved' : 'Dismissed'} {relativeTime(m.resolved_at)}
          </span>
        )}
      </div>

      <h2 id={`msg-${m.id}-title`} className="text-section text-text-1">{m.title}</h2>

      {m.body && (
        <div className="prose-report max-w-[72ch] mt-2">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown>
        </div>
      )}

      {m.links.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {m.links.map((link, i) => {
            const Icon = LINK_ICON[link.kind]
            return (
              <Button
                key={`${link.kind}-${link.target}-${i}`}
                tone="ghost"
                size="xs"
                icon={<Icon size={12} />}
                onClick={() => onOpenLink(link)}
                title={link.kind === 'application' ? `Application ${link.target}` : link.target}
                className="max-w-[40ch]"
              >
                <span className="truncate">{linkLabel(link)}</span>
              </Button>
            )
          })}
        </div>
      )}

      {!open && m.resolution_note && (
        <p className="mt-3 text-label text-text-2"><span className="text-text-3">Note:</span> {m.resolution_note}</p>
      )}

      {open && noting && (
        <div className="mt-3 flex flex-col gap-2">
          <label className="label" htmlFor={`msg-${m.id}-note`}>Note (optional)</label>
          <textarea
            id={`msg-${m.id}-note`}
            className="input min-h-[64px] py-2 resize-y"
            value={note}
            maxLength={2000}
            autoFocus
            placeholder="What you decided or did, for the agent that reads this later"
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void act('resolved', note)
              if (e.key === 'Escape') setNoting(false)
            }}
          />
          <div className="flex items-center gap-2">
            <Button tone="primary" size="sm" icon={<Check size={14} />} loading={busy === 'resolved'} onClick={() => void act('resolved', note)}>
              Mark resolved
            </Button>
            <Button tone="ghost" size="sm" onClick={() => { setNoting(false); setNote('') }}>Cancel</Button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-label text-danger" role="alert">{error}</p>}

      {!noting && (
        <div className="mt-3 flex items-center gap-2">
          {open ? (
            <>
              <Button
                size="sm"
                icon={<Check size={14} />}
                disabled={!canWrite || busy !== null}
                title={readOnlyTitle}
                onClick={() => setNoting(true)}
              >
                Resolve
              </Button>
              <Button
                tone="ghost"
                size="sm"
                icon={<X size={14} />}
                loading={busy === 'dismissed'}
                disabled={!canWrite || busy !== null}
                title={readOnlyTitle ?? 'Close it without acting on it'}
                onClick={() => void act('dismissed')}
              >
                Dismiss
              </Button>
            </>
          ) : (
            <>
              <Button
                tone="ghost"
                size="sm"
                icon={<RotateCcw size={14} />}
                loading={busy === 'open'}
                disabled={!canWrite || busy !== null}
                title={readOnlyTitle}
                onClick={() => void act('open')}
              >
                Reopen
              </Button>
              <Button tone="ghost" size="sm" onClick={() => setExpanded(false)}>Collapse</Button>
            </>
          )}
        </div>
      )}
    </article>
  )
}
