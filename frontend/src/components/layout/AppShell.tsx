'use client'

import { useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { CmdK } from '@/components/shared/CmdK'
import { useDataStore } from '@/store/data'
import { useNavStore, type ViewId } from '@/store/nav'
import { useConfigDirty } from '@/store/configDirty'
import { UnsavedChangesModal } from '@/components/shared/UnsavedChangesModal'
import { CommandCenter } from '@/components/command-center/CommandCenter'
import { ApplyingView } from '@/components/applying/ApplyingView'
import { DatabaseView } from '@/components/database/DatabaseView'
import { ReportsView } from '@/components/reports/ReportsView'
import { TrendsView } from '@/components/trends/TrendsView'
import { ScanView } from '@/components/scan/ScanView'
import { SettingsView } from '@/components/settings/SettingsView'
import { ConfigurationView } from '@/components/configuration/ConfigurationView'
import { ProfileView } from '@/components/profile/ProfileView'
import { AddListingModal } from '@/components/scouting/AddListingModal'

// Display labels for the cross-view nav guard's modal copy. Keep in
// sync with the Sidebar's NavItem labels.
const VIEW_LABELS: Record<ViewId, string> = {
  scouting: 'Scouting',
  applying: 'Applying',
  database: 'Database',
  reports:  'Reports',
  trends:   'Trends',
  scan:     'Activity',
  config:   'Configuration',
  settings: 'Settings',
  profile:  'Profile',
}

export function AppShell() {
  const load = useDataStore(s => s.load)
  const view = useNavStore(s => s.view)
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
    // Switching views unmounts ConfigurationView (and its sub-tabs),
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
        {view === 'scouting' && <CommandCenter />}
        {view === 'applying' && <ApplyingView />}
        {view === 'database' && <DatabaseView />}
        {view === 'reports'  && <ReportsView />}
        {view === 'trends'   && <TrendsView />}
        {view === 'scan'     && <ScanView />}
        {view === 'config'   && <ConfigurationView />}
        {view === 'settings' && <SettingsView />}
        {view === 'profile'  && <ProfileView />}
      </main>
      <CmdK />
      <AddListingModal />

      {/* Cross-view unsaved-changes guard. Fires when the user clicks a
          sidebar item (or anything else that calls navigate()) while
          Configuration has dirty form state. The intra-Configuration
          sub-tab modal is rendered separately by ConfigurationView. */}
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
