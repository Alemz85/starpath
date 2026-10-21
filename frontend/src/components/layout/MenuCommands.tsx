'use client'

import { useEffect } from 'react'
import { ipc } from '@/lib/ipc'
import { useNavStore, type ViewId } from '@/store/nav'
import { sendAppCommand, type AppCommand } from '@/lib/appCommands'

// The view a menu command needs on screen before it can run. `null` means the
// command is global (the palette, the shortcuts panel).
const VIEW_FOR: Record<AppCommand, ViewId | null> = {
  'add-listing':   'scouting',
  'scan:full':     'scouting',
  'scan:api':      'scouting',
  'scan:filtered': 'scouting',
  'filter-db':     'scouting',
  export:          'database',
  search:          'database',
  palette:         null,
  shortcuts:       null,
}

/** Maps the native menu bar's command ids onto the nav store and the app's
 *  command bus, and tells main whether the sidebar is showing so View ›
 *  Hide Sidebar / Show Sidebar reads the right way round. Renders nothing. */
export function MenuCommands() {
  const navigate = useNavStore(s => s.navigate)
  const toggleSidebar = useNavStore(s => s.toggleSidebar)
  const sidebarExpanded = useNavStore(s => s.sidebarExpanded)

  useEffect(() => {
    const off = ipc.onMenuCommand((id) => {
      if (id.startsWith('nav:')) { navigate(id.slice(4) as ViewId); return }
      if (id === 'toggle-sidebar') { toggleSidebar(); return }
      const cmd = id as AppCommand
      if (!(cmd in VIEW_FOR)) return
      const view = VIEW_FOR[cmd]
      if (view) navigate(view)
      // Let the destination mount before it hears the command.
      window.setTimeout(() => sendAppCommand(cmd), view ? 60 : 0)
    })
    return () => { if (typeof off === 'function') off() }
  }, [navigate, toggleSidebar])

  useEffect(() => { void ipc.setSidebarVisible(sidebarExpanded) }, [sidebarExpanded])

  return null
}
