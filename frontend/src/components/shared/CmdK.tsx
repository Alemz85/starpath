'use client'

import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import {
  Search, Database, FileText,
  TrendingUp, Activity, Settings, SlidersHorizontal, Map, Briefcase, Plus, Building2,
} from 'lucide-react'
import { useAddListingStore } from '@/store/addListing'
import { toCompanySlug } from '@/components/shared/CompanyLink'

export function CmdK() {
  const [open, setOpen] = useState(false)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const scouting = useDataStore(s => s.scouting)
  const navigate = useNavStore(s => s.navigate)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(o => !o)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const go = (view: Parameters<typeof navigate>[0], filter?: string) => {
    navigate(view, filter)
    setOpen(false)
  }

  // Companies open their dossier — the per-company view with aggregate
  // stats, application status, and the roles table. navigate('company', …)
  // keeps it inside the AppShell (a real /company route navigation would
  // full-reload and reset nav state under static export).
  const goCompany = (company: string) => {
    navigate('company', '', toCompanySlug(company))
    setOpen(false)
  }

  const companies = [...new Set([
    ...scoreHistory.map(s => s.company),
    ...scouting.map(s => s.company),
  ])].sort()

  return open ? (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={() => setOpen(false)}
    >
      <div className="w-[600px] bg-bg-panel border border-border-strong rounded-lg shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <Command className="text-body">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border-default">
            <Search size={15} className="text-text-3 shrink-0" />
            <Command.Input
              autoFocus
              placeholder="Search companies, views, actions…"
              className="flex-1 bg-transparent outline-none text-text-1 placeholder:text-text-4"
            />
            <kbd className="text-[10px] text-text-4 bg-bg-elevated border border-border-default rounded px-1.5 py-0.5">ESC</kbd>
          </div>

          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-label text-text-4">
              No results.
            </Command.Empty>

            <Command.Group heading={<span className="text-micro text-text-4 uppercase px-2">Navigate</span>}>
              {([
                { view: 'scouting', label: 'Scouting', icon: Map        },
                { view: 'applying', label: 'Applying', icon: Briefcase  },
                { view: 'database', label: 'Database', icon: Database   },
                { view: 'reports',  label: 'Reports',  icon: FileText   },
                { view: 'trends',   label: 'Trends',   icon: TrendingUp },
                { view: 'scan',     label: 'Activity',       icon: Activity         },
                { view: 'config',   label: 'Configuration',  icon: SlidersHorizontal},
                { view: 'settings', label: 'Settings',       icon: Settings         },
              ] as const).map(({ view, label, icon: Icon }) => (
                <Command.Item
                  key={view}
                  value={label}
                  onSelect={() => go(view)}
                  className="flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-text-2 data-[selected=true]:bg-accent/15 data-[selected=true]:text-text-1 transition-colors"
                >
                  <Icon size={14} className="text-text-3" />
                  {label}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading={<span className="text-micro text-text-4 uppercase px-2">Actions</span>}>
              <Command.Item
                value="add listing url paste evaluate"
                onSelect={() => {
                  useAddListingStore.getState().show()
                  setOpen(false)
                }}
                className="flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-text-2 data-[selected=true]:bg-accent/15 data-[selected=true]:text-text-1 transition-colors"
              >
                <Plus size={14} className="text-accent" />
                Add listing (paste URL)
              </Command.Item>
              <Command.Item
                value="open activity"
                onSelect={() => go('scan')}
                className="flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-text-2 data-[selected=true]:bg-accent/15 data-[selected=true]:text-text-1 transition-colors"
              >
                <Activity size={14} className="text-text-3" />
                Open Activity
              </Command.Item>
            </Command.Group>

            {companies.length > 0 && (
              <Command.Group heading={<span className="text-micro text-text-4 uppercase px-2">Companies</span>}>
                {companies.slice(0, 15).map(company => (
                  <Command.Item
                    key={company}
                    value={company}
                    onSelect={() => goCompany(company)}
                    className="flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-text-2 data-[selected=true]:bg-accent/15 data-[selected=true]:text-text-1 transition-colors"
                  >
                    <Building2 size={14} className="text-text-3" />
                    {company}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  ) : null
}
