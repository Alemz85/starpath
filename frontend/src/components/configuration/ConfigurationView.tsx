'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ProfileEditPanel } from '@/components/profile/ProfileEditPanel'
import { RolesTab, PortalsTab } from '@/components/settings/SettingsView'

// Three sub-tabs:
//   Identity → ProfileEditPanel (full-name / contact / phone / comp /
//              languages — everything that lives under candidate: in
//              user/profile.yml).
//   Roles    → target_roles.primary chips + dream-companies block.
//   Portals  → keyword filters + tracked companies + lang_blocklist.
//
// All three tabs share one underlying file pair (user/profile.yml,
// user/portals.yml), so visually grouping them under one Configuration
// surface keeps the user from hunting between Profile / Settings / etc.
// when they want to change *anything* about how the system reads them.

type Tab = 'identity' | 'roles' | 'portals'

const TABS: { key: Tab; label: string; sub: string }[] = [
  { key: 'identity', label: 'Identity',     sub: 'Name, contact, compensation, languages.' },
  { key: 'roles',    label: 'Target Roles', sub: 'Primary archetypes and dream companies.' },
  { key: 'portals',  label: 'Portals',      sub: 'Title filters, tracked companies, language blocklist.' },
]

export function ConfigurationView() {
  const [tab, setTab] = useState<Tab>('identity')
  const active = TABS.find(t => t.key === tab) ?? TABS[0]

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Configuration</h1>
        <span className="text-label text-text-4">·</span>
        <span className="text-label text-text-3">{active.sub}</span>
      </div>

      <div className="flex items-center border-b border-border-default bg-bg-chrome shrink-0 px-2">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'px-4 py-2.5 text-label border-b-2 transition-colors',
              tab === key
                ? 'border-accent text-text-1'
                : 'border-transparent text-text-4 hover:text-text-2',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'identity' && (
          <div className="max-w-[820px] mx-auto w-full px-5 pt-4 pb-10">
            <ProfileEditPanel />
          </div>
        )}
        {tab === 'roles'   && <RolesTab />}
        {tab === 'portals' && <PortalsTab />}
      </div>
    </div>
  )
}
