'use client'

import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui'

// Shared "Unsaved changes" modal used in two places:
//
//   1. SettingsView's intra-view sub-tab switch (General ↔ Identity ↔
//      Roles ↔ Portals) when the active sub-tab has dirty form state.
//   2. AppShell's cross-view nav guard — when the user is on Settings
//      with unsaved edits and clicks any other primary tab in the Sidebar.
//
// Behavior is intentionally identical across both surfaces so the user
// learns one prompt: cancel (stay), discard (drop edits), or save and
// switch. Esc cancels, Enter saves; Discard is button-only on purpose so
// accidental Enter never drops the user's work.

export function UnsavedChangesModal({
  targetLabel,
  saving,
  onSave,
  onDiscard,
  onCancel,
}: {
  /** Label of the destination tab/view, shown inline in the prompt copy. */
  targetLabel: string
  saving: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}) {
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => { if (!saving) onCancel() }}
      style={{ animation: 'chip-appear 160ms ease both' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-[420px] rounded-xl bg-bg-base border border-border-default shadow-lift overflow-hidden"
      >
        <div className="px-5 pt-4 pb-4">
          <h3 className="text-title text-text-1 flex items-center gap-2">
            <AlertTriangle size={15} className="text-warning-text shrink-0" aria-hidden />
            Unsaved changes
          </h3>
          <p className="text-body text-text-3 mt-1.5">
            You have edits on this tab. Save them before switching to <span className="font-medium text-text-2">{targetLabel}</span>, or discard.
          </p>
        </div>
        <div className="px-5 py-3 flex items-center gap-2 bg-bg-elevated/60 border-t border-border-default">
          <Button tone="secondary" size="sm" onClick={onDiscard} disabled={saving} className="mr-auto">
            Discard
          </Button>
          <Button tone="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button tone="primary" size="sm" onClick={onSave} loading={saving}>
            {saving ? 'Saving…' : 'Save and switch'}
          </Button>
        </div>
      </div>
    </div>
  )
}
