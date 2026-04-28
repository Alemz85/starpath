'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ProfileEditPanel } from '@/components/profile/ProfileEditPanel'
import { RolesTab, PortalsTab } from '@/components/settings/SettingsView'
import { useConfigDirty, type ConfigTab } from '@/store/configDirty'

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
          targetTab={TABS.find(t => t.key === pendingTab)!.label}
          saving={savingAll}
          onSave={saveAndSwitch}
          onDiscard={discardAndSwitch}
          onCancel={() => setPendingTab(null)}
        />
      )}
    </div>
  )
}

function UnsavedChangesModal({
  targetTab, saving, onSave, onDiscard, onCancel,
}: {
  targetTab: string
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}) {
  // Keyboard: Esc cancels (stay in current tab), Enter saves (the
  // primary action — matches the visual hierarchy below). The
  // destructive Discard path is button-only on purpose, so accidental
  // Enter doesn't drop the user's work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter' && !saving) onSave()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onSave, onCancel, saving])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onClick={() => { if (!saving) onCancel() }}
      style={{ animation: 'chip-appear 160ms ease both' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-[420px] rounded-xl bg-bg-panel border border-border-strong shadow-lift overflow-hidden"
      >
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-warning/10 border border-warning/30 flex items-center justify-center shrink-0">
              <AlertTriangle size={18} className="text-warning" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-[15px] font-semibold text-text-1 leading-tight">Unsaved changes</h3>
              <p className="text-[12.5px] text-text-3 mt-1.5 leading-relaxed">
                You have edits on this tab. Save them before switching to <span className="font-medium text-text-2">{targetTab}</span>, or discard.
              </p>
            </div>
          </div>
        </div>
        <div className="px-5 py-3 flex items-center justify-end gap-2 bg-bg-chrome border-t border-border-default">
          <button
            onClick={onCancel}
            disabled={saving}
            className="px-3 py-1.5 text-label text-text-2 rounded-md hover:bg-bg-elevated disabled:opacity-40 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onDiscard}
            disabled={saving}
            className="px-3 py-1.5 text-label text-danger bg-danger/10 border border-danger/30 rounded-md hover:bg-danger/15 disabled:opacity-40 transition-colors"
          >
            Discard
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-label text-accent-text bg-accent/20 border border-accent/35 rounded-md hover:bg-accent/30 disabled:opacity-40 transition-colors font-medium"
          >
            {saving && <Loader2 size={12} className="animate-spin" />}
            {saving ? 'Saving…' : 'Save and switch'}
          </button>
        </div>
      </div>
    </div>
  )
}
