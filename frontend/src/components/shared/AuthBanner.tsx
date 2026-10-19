'use client'

import { AlertTriangle, X } from 'lucide-react'
import { useAppStore } from '@/store/app'
import { Button } from '@/components/ui'

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
    <div className="shrink-0 h-9 flex items-center gap-2.5 px-4 bg-warning/15 border-b border-warning/30 text-label text-warning-text">
      <AlertTriangle size={14} className="shrink-0" aria-hidden />
      <span className="flex-1 min-w-0 truncate" title={message}>{message}</span>

      <Button
        tone="primary"
        size="xs"
        onClick={() => relogin()}
        loading={reloginInProgress}
      >
        {reloginInProgress ? 'Waiting for sign-in…' : 'Sign in'}
      </Button>

      <Button
        tone="ghost"
        size="xs"
        iconOnly
        icon={<X size={14} aria-hidden />}
        onClick={clearAuthError}
        aria-label="Dismiss"
        className="text-warning-text hover:bg-warning/20 hover:text-text-1"
      />
    </div>
  )
}
