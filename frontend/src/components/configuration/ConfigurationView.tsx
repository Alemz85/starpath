'use client'

import { useCallback, useRef, useState } from 'react'
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

const PANEL_ID = (key: ConfigTab) => `config-panel-${key}`

export function ConfigurationView() {
  const [tab, setTab] = useState<ConfigTab>('identity')
  // pendingTab is set when the user clicks a different tab while the
  // current tab is dirty. The modal asks them to discard or stay.
  const [pendingTab, setPendingTab] = useState<ConfigTab | null>(null)
  const tabRefs = useRef<Partial<Record<ConfigTab, HTMLButtonElement>>>({})

  // Subscribe to all three dirty sets so the dot appears on whichever tab
  // has unsaved changes — including the inactive ones.
  const identityDirty = useConfigDirty(s => s.identity.size > 0)
  const rolesDirty    = useConfigDirty(s => s.roles.size > 0)
  const portalsDirty  = useConfigDirty(s => s.portals.size > 0)
  const dirtyByTab: Record<ConfigTab, boolean> = {
    identity: identityDirty,
    roles:    rolesDirty,
    portals:  portalsDirty,
  }
  const isDirty = dirtyByTab[tab]

  const requestSwitch = useCallback((next: ConfigTab) => {
    if (next === tab) return
    if (isDirty) {
      setPendingTab(next)
    } else {
      setTab(next)
    }
  }, [tab, isDirty])

  // Arrow-key navigation within the tablist (ARIA authoring practices).
  const handleTabKeyDown = useCallback((e: React.KeyboardEvent, key: ConfigTab) => {
    const idx = TABS.findIndex(t => t.key === key)
    let nextIdx: number | null = null
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % TABS.length
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') nextIdx = 0
    else if (e.key === 'End') nextIdx = TABS.length - 1
    if (nextIdx !== null) {
      e.preventDefault()
      const nextKey = TABS[nextIdx].key
      tabRefs.current[nextKey]?.focus()
      requestSwitch(nextKey)
    }
  }, [requestSwitch])

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
      {/* Title bar — subtitle cross-fades when the tab changes */}
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Configuration</h1>
        <span className="text-label text-text-4" aria-hidden="true">·</span>
        <span
          key={active.key}
          className="text-label text-text-3 transition-opacity duration-150"
        >
          {active.sub}
        </span>
      </div>

      {/* Tab navigation */}
      <div
        role="tablist"
        aria-label="Configuration sections"
        className="flex items-center border-b border-border-default bg-bg-chrome shrink-0 px-2"
      >
        {TABS.map(({ key, label }) => {
          const isActive = tab === key
          const hasDot = dirtyByTab[key]
          return (
            <button
              key={key}
              ref={el => { if (el) tabRefs.current[key] = el }}
              role="tab"
              aria-selected={isActive}
              aria-controls={PANEL_ID(key)}
              id={`config-tab-${key}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => requestSwitch(key)}
              onKeyDown={e => handleTabKeyDown(e, key)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-label border-b-2 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset',
                isActive
                  ? 'border-accent text-text-1'
                  : 'border-transparent text-text-4 hover:text-text-2',
              )}
            >
              {label}
              {hasDot && (
                <span
                  aria-label="Unsaved changes"
                  title="Unsaved changes"
                  className={cn(
                    'w-1.5 h-1.5 rounded-full bg-accent shrink-0',
                    // Dim slightly on inactive tabs so it reads as a
                    // passive indicator rather than a loud warning.
                    !isActive && 'opacity-60',
                  )}
                />
              )}
            </button>
          )
        })}
      </div>

      {/* Tab panels — one panel per tab, hidden when not active */}
      <div className="flex-1 overflow-y-auto">
        <div
          role="tabpanel"
          id={PANEL_ID('identity')}
          aria-labelledby="config-tab-identity"
          hidden={tab !== 'identity'}
          className="h-full"
        >
          {tab === 'identity' && (
            <div className="max-w-[820px] mx-auto w-full px-5 pt-4 pb-10">
              <ProfileEditPanel />
            </div>
          )}
        </div>
        <div
          role="tabpanel"
          id={PANEL_ID('roles')}
          aria-labelledby="config-tab-roles"
          hidden={tab !== 'roles'}
          className="h-full"
        >
          {tab === 'roles' && <RolesTab />}
        </div>
        <div
          role="tabpanel"
          id={PANEL_ID('portals')}
          aria-labelledby="config-tab-portals"
          hidden={tab !== 'portals'}
          className="h-full"
        >
          {tab === 'portals' && <PortalsTab />}
        </div>
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
