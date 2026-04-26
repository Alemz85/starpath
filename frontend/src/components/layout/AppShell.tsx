'use client'

import { useEffect } from 'react'
import { Sidebar } from './Sidebar'
import { CmdK } from '@/components/shared/CmdK'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { CommandCenter } from '@/components/command-center/CommandCenter'
import { DatabaseView } from '@/components/database/DatabaseView'
import { ReportsView } from '@/components/reports/ReportsView'
import { PipelineView } from '@/components/pipeline/PipelineView'
import { TrendsView } from '@/components/trends/TrendsView'
import { ScanView } from '@/components/scan/ScanView'
import { SettingsView } from '@/components/settings/SettingsView'

export function AppShell() {
  const load = useDataStore(s => s.load)
  const view = useNavStore(s => s.view)

  useEffect(() => { load() }, [load])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-base">
      <Sidebar />
      <main className="flex-1 overflow-hidden flex flex-col min-w-0">
        {view === 'home'     && <CommandCenter />}
        {view === 'database' && <DatabaseView />}
        {view === 'reports'  && <ReportsView />}
        {view === 'pipeline' && <PipelineView />}
        {view === 'trends'   && <TrendsView />}
        {view === 'scan'     && <ScanView />}
        {view === 'settings' && <SettingsView />}
      </main>
      <CmdK />
    </div>
  )
}
