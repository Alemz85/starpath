'use client'

import { useEffect } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

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
                You have edits on this tab. Save them before switching to <span className="font-medium text-text-2">{targetLabel}</span>, or discard.
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
