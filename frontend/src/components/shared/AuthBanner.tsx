'use client'

import { AlertTriangle, Loader2, X } from 'lucide-react'
import { useAppStore } from '@/store/app'
import { ClaudeLogo } from '@/components/shared/Logos'

// Global, dismissible strip across the top of the main content area. Shows
// whenever the Claude session is dead — detected at launch (expired/lost
// token) or at runtime when a `claude -p` run 401s mid-scan. Without it an
// expired token reads as a generic "× error" in the activity panel with no
// way to recover; here the fix is one click.
export function AuthBanner() {
  const authError = useAppStore(s => s.authError)
  const reloginInProgress = useAppStore(s => s.reloginInProgress)
  const relogin = useAppStore(s => s.relogin)
  const clearAuthError = useAppStore(s => s.clearAuthError)

  if (!authError) return null

  const message =
    authError === 'logged-out'
      ? "You're signed out of Claude. Sign in to run scans and evaluations."
      : 'Your Claude session expired. Sign in again to keep running scans and evaluations.'

  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-warning/10 border-b border-warning/30">
      <AlertTriangle size={15} className="text-warning shrink-0" />
      <span className="flex-1 text-[13px] text-text-2 leading-snug">{message}</span>

      <button
        onClick={() => relogin()}
        disabled={reloginInProgress}
        className="inline-flex items-center gap-2 pl-1.5 pr-3.5 h-8 bg-accent hover:bg-accent-hover active:scale-[0.98] text-white rounded-pill text-[12.5px] font-medium transition-all shadow-pill hover:shadow-pill-hover disabled:opacity-70 disabled:active:scale-100"
      >
        {reloginInProgress ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <span className="bg-white rounded-full p-1"><ClaudeLogo size={12} /></span>
        )}
        {reloginInProgress ? 'Waiting for sign-in…' : 'Sign in again'}
      </button>

      <button
        onClick={clearAuthError}
        aria-label="Dismiss"
        className="p-1 rounded-md text-text-3 hover:text-text-1 hover:bg-bg-elevated transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  )
}
