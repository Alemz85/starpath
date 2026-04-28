'use client'

import { useEffect } from 'react'
import { Sidebar } from './Sidebar'
import { CmdK } from '@/components/shared/CmdK'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { CommandCenter } from '@/components/command-center/CommandCenter'
import { ApplyingView } from '@/components/applying/ApplyingView'
import { DatabaseView } from '@/components/database/DatabaseView'
import { ReportsView } from '@/components/reports/ReportsView'
import { TrendsView } from '@/components/trends/TrendsView'
import { ScanView } from '@/components/scan/ScanView'
import { SettingsView } from '@/components/settings/SettingsView'
import { ConfigurationView } from '@/components/configuration/ConfigurationView'
import { ProfileView } from '@/components/profile/ProfileView'

export function AppShell() {
  const load = useDataStore(s => s.load)
  const view = useNavStore(s => s.view)

  useEffect(() => { load() }, [load])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-base">
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
    </div>
  )
}
