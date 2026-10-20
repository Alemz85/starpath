'use client'

import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import {
  Search, Database, FileText,
  TrendingUp, Activity, Settings, Map, Briefcase, Plus, Building2, Sun, Users, Scale, Waypoints, ArrowRightLeft, User,
} from 'lucide-react'
import { useAddListingStore } from '@/store/addListing'
import { useProfilesStore } from '@/store/profiles'
import { useAppStore } from '@/store/app'
import { isViewEnabled } from '@/lib/features'
import { switchTargets } from '@/lib/profiles'
import { toCompanySlug } from '@/components/shared/CompanyLink'

// One look for every palette row: 34px, 6px radius, accent wash when selected.
const ITEM_CLS =
  'flex items-center gap-2.5 h-[34px] px-2.5 rounded cursor-pointer text-body text-text-2 ' +
  'data-[selected=true]:bg-accent-soft data-[selected=true]:text-text-1 transition-colors duration-150 ease-quart'

// Group heading: a sentence-case `.label`.
function GroupHeading({ children }: { children: React.ReactNode }) {
  return <span className="label block px-2.5 pt-2 pb-1">{children}</span>
}

export function CmdK() {
  const [open, setOpen] = useState(false)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const scouting = useDataStore(s => s.scouting)
  const navigate = useNavStore(s => s.navigate)
  // Non-active profiles become "Switch to profile: …" commands. Empty on
  // pre-migration repos, so the group hides itself.
  const profiles = useProfilesStore(s => s.profiles)
  const profileTargets = switchTargets(profiles)
  const features = useAppStore(s => s.features)

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

  // `tab` targets a sub-tab inside the destination view (Outreach › Network,
  // Trends › Score Trend, Settings sections) via the nav store's one-shot
  // viewTab request.
  const go = (view: Parameters<typeof navigate>[0], filter?: string, tab?: string) => {
    navigate(view, filter, '', tab)
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
      <div className="w-[600px] bg-bg-base border border-border-default rounded-xl shadow-lift overflow-hidden" onClick={e => e.stopPropagation()}>
        <Command className="text-body">
          <div className="flex items-center gap-2.5 h-11 px-4 border-b border-border-default">
            <Search size={15} className="text-text-3 shrink-0" aria-hidden />
            <Command.Input
              autoFocus
              placeholder="Search companies, views, actions…"
              className="flex-1 h-full border-0 bg-transparent outline-none text-body text-text-1 placeholder:text-text-4"
            />
            <kbd className="kbd">Esc</kbd>
          </div>

          <Command.List className="max-h-80 overflow-y-auto p-1.5">
            <Command.Empty className="py-6 text-center text-label text-text-4">
              No results.
            </Command.Empty>

            <Command.Group heading={<GroupHeading>Navigate</GroupHeading>}>
              {/* Former standalone views kept as entries targeting their new
                  sub-tab home, so muscle-memory searches still land right:
                  Network → Outreach › Network. Configuration's editor
                  sections live under Settings. */}
              {([
                { view: 'scouting', label: 'Scout',    icon: Map        },
                { view: 'applying', label: 'Applying', icon: Briefcase  },
                { view: 'outreach', label: 'Outreach', icon: Users      },
                { view: 'offers',   label: 'Offers',   icon: Scale      },
                { view: 'outreach', label: 'Network',  icon: Waypoints, tab: 'network' },
                { view: 'database', label: 'Database', icon: Database   },
                { view: 'reports',  label: 'Reports',  icon: FileText   },
                { view: 'trends',   label: 'Trends',   icon: TrendingUp },
                { view: 'scan',     label: 'Activity', icon: Activity   },
                { view: 'settings', label: 'Settings', icon: Settings   },
                { view: 'profile',  label: 'Profile',  icon: User       },
              ] as const)
                // Deactivated features drop their entries (isViewEnabled).
                .filter(({ view }) => isViewEnabled(view, features))
                .map(({ view, label, icon: Icon, ...rest }) => (
                <Command.Item
                  key={label}
                  value={label}
                  onSelect={() => go(view, '', 'tab' in rest ? rest.tab : undefined)}
                  className={ITEM_CLS}
                >
                  <Icon size={14} className="text-text-3" />
                  {label}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading={<GroupHeading>Actions</GroupHeading>}>
              <Command.Item
                value="add listing url paste evaluate"
                onSelect={() => {
                  useAddListingStore.getState().show()
                  setOpen(false)
                }}
                className={ITEM_CLS}
              >
                <Plus size={14} className="text-accent-text" />
                Add listing (paste URL)
              </Command.Item>
              <Command.Item
                value="log a touch outreach contact nudge"
                onSelect={() => go('outreach')}
                className={ITEM_CLS}
              >
                <Users size={14} className="text-text-3" />
                Log outreach touch
              </Command.Item>
              <Command.Item
                value="open activity"
                onSelect={() => go('scan')}
                className={ITEM_CLS}
              >
                <Activity size={14} className="text-text-3" />
                Open Activity
              </Command.Item>
            </Command.Group>

            {profileTargets.length > 0 && (
              <Command.Group heading={<GroupHeading>Profiles</GroupHeading>}>
                {profileTargets.map(p => (
                  <Command.Item
                    key={p.slug}
                    value={`switch to profile ${p.label} ${p.slug}`}
                    onSelect={() => {
                      // Guard refusals surface in the sidebar switcher popover
                      // and the Settings profiles section (lastFailure).
                      void useProfilesStore.getState().switchTo(p.slug)
                      setOpen(false)
                    }}
                    className={ITEM_CLS}
                  >
                    <ArrowRightLeft size={14} className="text-text-3" />
                    Switch to profile: {p.label || p.slug}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {companies.length > 0 && (
              <Command.Group heading={<GroupHeading>Companies</GroupHeading>}>
                {companies.slice(0, 15).map(company => (
                  <Command.Item
                    key={company}
                    value={company}
                    onSelect={() => goCompany(company)}
                    className={ITEM_CLS}
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
