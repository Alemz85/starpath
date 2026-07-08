'use client'

import { useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { CmdK } from '@/components/shared/CmdK'
import { ShortcutsOverlay } from '@/components/shared/ShortcutsOverlay'
import { useDataStore } from '@/store/data'
import { useNavStore, VIEW_LABELS } from '@/store/nav'
import { useConfigDirty } from '@/store/configDirty'
import { UnsavedChangesModal } from '@/components/shared/UnsavedChangesModal'
import { TodayView } from '@/components/today/TodayView'
import { CommandCenter } from '@/components/command-center/CommandCenter'
import { ApplyingView } from '@/components/applying/ApplyingView'
import { OutreachView } from '@/components/outreach/OutreachView'
import { OffersView } from '@/components/offers/OffersView'
import { DatabaseView } from '@/components/database/DatabaseView'
import { ReportsView } from '@/components/reports/ReportsView'
import { TrendsView } from '@/components/trends/TrendsView'
import { PipelineView } from '@/components/pipeline/PipelineView'
import { ScanView } from '@/components/scan/ScanView'
import { SettingsView } from '@/components/settings/SettingsView'
import { ProfileView } from '@/components/profile/ProfileView'
import { CompanyView } from '@/components/company/CompanyView'
import { AddListingModal } from '@/components/scouting/AddListingModal'
import { AuthBanner } from '@/components/shared/AuthBanner'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'

export function AppShell() {
  const load = useDataStore(s => s.load)
  const view = useNavStore(s => s.view)
  const companySlug = useNavStore(s => s.companySlug)
  const pendingView = useNavStore(s => s.pendingView)
  const confirmPendingNavigate = useNavStore(s => s.confirmPendingNavigate)
  const cancelPendingNavigate = useNavStore(s => s.cancelPendingNavigate)
  const [savingDirty, setSavingDirty] = useState(false)

  useEffect(() => { load() }, [load])

  const handleSave = async () => {
    setSavingDirty(true)
    try {
      await useConfigDirty.getState().saveAllDirty()
    } finally {
      setSavingDirty(false)
    }
    // Each section's save handler clears its own dirty flag and
    // updates its baseline. Now perform the captured nav.
    confirmPendingNavigate()
  }

  const handleDiscard = () => {
    // Switching views unmounts SettingsView (and its editor sub-tabs),
    // which evaporates each section's local form state and triggers
    // the registered cleanup effects that clear dirty flags. So the
    // discard path doesn't need to manually reset anything here —
    // confirming the nav does the work.
    confirmPendingNavigate()
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-cosmos">
      {/* Fixed-position grain overlay — adds 2.5% galaxy-tinted noise
          across the whole viewport so the violet-cool wash of bg-cosmos
          reads as an atmospheric surface rather than a flat tinted
          background. pointer-events: none. */}
      <div className="cosmos-grain" aria-hidden />
      <Sidebar />
      <main className="flex-1 overflow-hidden flex flex-col min-w-0">
        {/* AuthBanner sits OUTSIDE the boundary so an expired-session prompt
            shows even if the active view itself crashes. */}
        <AuthBanner />
        {/* key={view} remounts a fresh boundary per tab, so a crash in one
            view clears the moment the user navigates to another. The boundary
            is transparent when healthy — it returns its children directly, so
            the view stays a direct flex child of <main>. */}
        <ErrorBoundary key={view} label={VIEW_LABELS[view]}>
          {view === 'today'    && <TodayView />}
          {view === 'scouting' && <CommandCenter />}
          {view === 'applying' && <ApplyingView />}
          {view === 'outreach' && <OutreachView />}
          {view === 'offers'   && <OffersView />}
          {view === 'database' && <DatabaseView />}
          {view === 'reports'  && <ReportsView />}
          {view === 'trends'   && <TrendsView />}
          {view === 'pipeline' && <PipelineView />}
          {view === 'scan'     && <ScanView />}
          {view === 'settings' && <SettingsView />}
          {view === 'profile'  && <ProfileView />}
          {view === 'company'  && <CompanyView slug={companySlug} />}
        </ErrorBoundary>
      </main>
      <CmdK />
      <ShortcutsOverlay />
      <AddListingModal />

      {/* Cross-view unsaved-changes guard. Fires when the user clicks a
          sidebar item (or anything else that calls navigate()) while
          Settings has dirty editor state. The intra-Settings sub-tab
          modal is rendered separately by SettingsView. */}
      {pendingView && (
        <UnsavedChangesModal
          targetLabel={VIEW_LABELS[pendingView]}
          saving={savingDirty}
          onSave={handleSave}
          onDiscard={handleDiscard}
          onCancel={cancelPendingNavigate}
        />
      )}
    </div>
  )
}
