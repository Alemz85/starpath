'use client'

import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/ui'
import { EmptyState } from '@/components/shared/EmptyState'
import { ViewTabs, viewPanelId, viewTabId } from '@/components/shared/ViewTabs'
import { ReportSlideOver } from '@/components/reports/ReportSlideOver'
import { orphanScoreEntry } from '@/components/reports/ReportsView'
import { ipc } from '@/lib/ipc'
import { splitMessages, type MessageLink, type MessageStatus } from '@/lib/messages'
import { useMessagesStore } from '@/store/messages'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useWriteGate } from '@/store/dataRoot'
import type { ReportFile } from '@/types'
import { MessageCard } from './MessageCard'

// Messages: notes agents leave the user (the weekly run, calibrate, eval
// workers, chat, any Claude Code session) via `npm run messages -- post`.
// Optional and rare by design: stuck, an important issue, or a change that
// needs the user's OK. Open ones newest first; History holds the resolved and
// dismissed ones. Report links open the dossier in place.

type Tab = 'open' | 'history'

export function MessagesView() {
  const messages = useMessagesStore(s => s.messages)
  const loaded = useMessagesStore(s => s.loaded)
  const load = useMessagesStore(s => s.load)
  const setStatus = useMessagesStore(s => s.setStatus)
  const reports = useDataStore(s => s.reports)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const navigate = useNavStore(s => s.navigate)
  const { canWrite, readOnlyTitle } = useWriteGate()
  const [tab, setTab] = useState<Tab>('open')
  const [report, setReport] = useState<ReportFile | null>(null)

  useEffect(() => { void load() }, [load])

  const { open, closed } = useMemo(() => splitMessages(messages), [messages])
  const shown = tab === 'open' ? open : closed

  const onSetStatus = async (id: string, status: MessageStatus, note?: string): Promise<string | null> => {
    const res = await setStatus(id, status, note)
    if (!res) return 'Not available outside the app'
    return res.ok ? null : res.error
  }

  const onOpenLink = (link: MessageLink) => {
    if (link.kind === 'url') { void ipc.openExternal(link.target); return }
    if (link.kind === 'application') { navigate('applying'); return }
    if (link.kind === 'report') {
      const hit = reports.find(r => r.path === link.target)
      if (hit) { setReport(hit); return }
    }
    void ipc.openFile(link.target)
  }

  const reportScore = report
    ? [...scoreHistory]
        .filter(r => r.company === report.company && r.role === report.role)
        .sort((a, b) => b.date.localeCompare(a.date))[0] ?? orphanScoreEntry(report)
    : null

  const meta = loaded
    ? `${open.length} open${closed.length ? ` · ${closed.length} closed` : ''}`
    : ''

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Messages" meta={meta} live />
      <ViewTabs
        tabs={[
          { key: 'open', label: 'Open', count: open.length },
          { key: 'history', label: 'History', count: closed.length },
        ]}
        active={tab}
        onSelect={setTab}
        ariaLabel="Messages"
        idPrefix="messages"
      />
      <div
        className="flex-1 min-h-0 overflow-y-auto p-5"
        role="tabpanel"
        id={viewPanelId('messages', tab)}
        aria-labelledby={viewTabId('messages', tab)}
      >
        {loaded && shown.length === 0 ? (
          <EmptyState
            className="h-full"
            title={tab === 'open' ? 'Nothing needs you' : 'No closed messages yet'}
            hint={tab === 'open'
              ? 'When an agent gets stuck, finds an important issue, or wants your OK before changing something, it leaves a note here.'
              : 'Messages you resolve or dismiss are kept here.'}
          />
        ) : tab === 'open' ? (
          <div className="flex flex-col gap-3 max-w-[880px]">
            {open.map(m => (
              <MessageCard key={m.id} message={m} canWrite={canWrite} readOnlyTitle={readOnlyTitle} onSetStatus={onSetStatus} onOpenLink={onOpenLink} />
            ))}
          </div>
        ) : (
          <div className="card max-w-[880px] overflow-hidden">
            {closed.map(m => (
              <MessageCard key={m.id} message={m} canWrite={canWrite} readOnlyTitle={readOnlyTitle} onSetStatus={onSetStatus} onOpenLink={onOpenLink} />
            ))}
          </div>
        )}
      </div>

      {report && reportScore && (
        <ReportSlideOver
          company={report.company}
          role={report.role}
          scoreEntry={reportScore}
          onClose={() => setReport(null)}
        />
      )}
    </div>
  )
}
