'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ProfileEditPanel } from '@/components/profile/ProfileEditPanel'
import { RolesTab, PortalsTab } from '@/components/settings/SettingsView'
import { useConfigDirty, type ConfigTab } from '@/store/configDirty'
import { UnsavedChangesModal } from '@/components/shared/UnsavedChangesModal'

// Three sub-tabs:
//   Identity → ProfileEditPanel (full-name / contact / phone / comp /
//              languages — everything that lives under candidate: in
//              user/profile.yml).
//   Roles    → target_roles.primary chips + dream-companies block +
//              target locations (preferred_cities).
//   Portals  → keyword filters + tracked companies + lang_blocklist.
//
// When the active tab has unsaved changes (any of its sub-sections has
// updated state since its last save), switching tabs prompts a confirm
// modal — explicit decision rather than silently dropping edits.

const TABS: { key: ConfigTab; label: string; sub: string }[] = [
  { key: 'identity', label: 'Identity',     sub: 'Name, contact, compensation, languages.' },
  { key: 'roles',    label: 'Target Roles', sub: 'Primary archetypes, dream companies, and preferred cities.' },
  { key: 'portals',  label: 'Portals',      sub: 'Title filters, tracked companies, language blocklist.' },
]

export function ConfigurationView() {
  const [tab, setTab] = useState<ConfigTab>('identity')
  // pendingTab is set when the user clicks a different tab while the
  // current tab is dirty. The modal asks them to discard or stay.
  const [pendingTab, setPendingTab] = useState<ConfigTab | null>(null)

  // The store holds Set<sourceId> per tab. The active tab is dirty if
  // its set is non-empty. We subscribe to the right slice so re-renders
  // only fire when the active tab's dirty state actually flips.
  const dirtySet = useConfigDirty(s => s[tab])
  const isDirty = dirtySet.size > 0

  const requestSwitch = (next: ConfigTab) => {
    if (next === tab) return
    if (isDirty) {
      setPendingTab(next)
    } else {
      setTab(next)
    }
  }

  const discardAndSwitch = () => {
    if (!pendingTab) return
    // Conditional rendering means the abandoned tab's component will
    // unmount, taking its local form state with it. The store's
    // unmount-cleanup effects clear the dirty flags. So discarding is
    // genuinely "drop the edits" — no further work needed here.
    setTab(pendingTab)
    setPendingTab(null)
  }

  const [savingAll, setSavingAll] = useState(false)
  const saveAndSwitch = async () => {
    if (!pendingTab) return
    setSavingAll(true)
    try {
      await useConfigDirty.getState().saveAll(tab)
    } finally {
      setSavingAll(false)
    }
    // After saveAll, each section has cleared its own dirty flag and
    // updated its baseline. We can switch now.
    setTab(pendingTab)
    setPendingTab(null)
  }

  const active = TABS.find(t => t.key === tab) ?? TABS[0]

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Configuration</h1>
        <span className="text-label text-text-4">·</span>
        <span className="text-label text-text-3">{active.sub}</span>
      </div>

      <div className="flex items-center border-b border-border-default bg-bg-chrome shrink-0 px-2">
        {TABS.map(({ key, label }) => {
          const isActive = tab === key
          // Show a small dot next to the active tab's label when it has
          // unsaved changes — a passive cue without being noisy.
          const showDot = isActive && isDirty
          return (
            <button
              key={key}
              onClick={() => requestSwitch(key)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-label border-b-2 transition-colors',
                isActive
                  ? 'border-accent text-text-1'
                  : 'border-transparent text-text-4 hover:text-text-2',
              )}
            >
              {label}
              {showDot && (
                <span
                  title="Unsaved changes"
                  className="w-1.5 h-1.5 rounded-full bg-accent"
                />
              )}
            </button>
          )
        })}
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

      {pendingTab && (
        <UnsavedChangesModal
          targetLabel={TABS.find(t => t.key === pendingTab)!.label}
          saving={savingAll}
          onSave={saveAndSwitch}
          onDiscard={discardAndSwitch}
          onCancel={() => setPendingTab(null)}
        />
      )}
    </div>
  )
}
