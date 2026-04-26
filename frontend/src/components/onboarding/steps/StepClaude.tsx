'use client'

import { useState, useEffect, useRef } from 'react'
import { Loader2, ExternalLink, CheckCircle2 } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useAppStore } from '@/store/app'

type State = 'checking' | 'not-installed' | 'login-prompt' | 'waiting' | 'done'

const POLL_INTERVAL = 2500
const POLL_TIMEOUT = 5 * 60 * 1000

export function StepClaude({ onComplete }: { onComplete: () => void }) {
  const { recheckClaude } = useAppStore()
  const [state, setState] = useState<State>('checking')
  const [rechecking, setRechecking] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    runCheck()
    return () => {
      clearInterval(pollRef.current!)
      clearTimeout(timerRef.current!)
    }
  }, [])

  const runCheck = async () => {
    setState('checking')
    const installed = await recheckClaude()
    if (!installed) {
      setState('not-installed')
      return
    }
    const { authenticated } = await ipc.checkClaudeAuth()
    if (authenticated) {
      setState('done')
      onComplete()
    } else {
      setState('login-prompt')
    }
  }

  const handleLogin = async () => {
    setState('waiting')
    await ipc.runClaudeLogin()

    // Poll until auth detected or timeout
    pollRef.current = setInterval(async () => {
      const { authenticated } = await ipc.checkClaudeAuth()
      if (authenticated) {
        clearInterval(pollRef.current!)
        clearTimeout(timerRef.current!)
        setState('done')
        onComplete()
      }
    }, POLL_INTERVAL)

    // Stop polling after 5 minutes and fall back to manual confirm
    timerRef.current = setTimeout(() => {
      clearInterval(pollRef.current!)
      setState('login-prompt')
    }, POLL_TIMEOUT)
  }

  const handleManualConfirm = async () => {
    clearInterval(pollRef.current!)
    const { authenticated } = await ipc.checkClaudeAuth()
    if (authenticated) {
      setState('done')
      onComplete()
    } else {
      // Trust the user — they may have just logged in
      onComplete()
    }
  }

  const handleRecheck = async () => {
    setRechecking(true)
    await recheckClaude()
    setRechecking(false)
    runCheck()
  }

  if (state === 'checking') {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-section text-text-1 mb-2">Connect your Claude account</h2>
          <p className="text-body text-text-3">
            career-ops uses Claude Code — your existing Anthropic subscription, no API key needed.
          </p>
        </div>
        <div className="flex items-center gap-3 text-text-3">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-body">Checking login status…</span>
        </div>
      </div>
    )
  }

  if (state === 'not-installed') {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-section text-text-1 mb-2">Connect your Claude account</h2>
          <p className="text-body text-text-3">
            career-ops uses Claude Code — your existing Anthropic subscription, no API key needed.
          </p>
        </div>
        <div className="p-4 bg-warning/10 border border-warning/30 rounded-md text-body text-warning">
          Claude Code not detected. Install it first, then come back.
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={handleRecheck}
            disabled={rechecking}
            className="flex items-center gap-2 px-4 py-2 bg-bg-elevated border border-border-default hover:border-accent text-text-2 rounded-md text-body transition-colors disabled:opacity-50"
          >
            {rechecking ? <Loader2 size={14} className="animate-spin" /> : null}
            {rechecking ? 'Checking…' : 'Re-check'}
          </button>
          <a
            href="https://claude.ai/download"
            onClick={e => { e.preventDefault(); ipc.openExternal('https://claude.ai/download') }}
            className="inline-flex items-center gap-2 text-accent-text hover:text-accent text-body transition-colors"
          >
            Download Claude Code <ExternalLink size={12} />
          </a>
        </div>
      </div>
    )
  }

  if (state === 'waiting') {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-section text-text-1 mb-2">Connect your Claude account</h2>
          <p className="text-body text-text-3">
            career-ops uses Claude Code — your existing Anthropic subscription, no API key needed.
          </p>
        </div>
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-text-2">
            <Loader2 size={14} className="animate-spin text-accent" />
            <span className="text-body">Browser opened — complete the login and return here.</span>
          </div>
          <p className="text-label text-text-4">This will complete automatically once you&apos;re logged in.</p>
          <button
            onClick={handleManualConfirm}
            className="text-body text-accent hover:text-accent/80 transition-colors font-medium"
          >
            Done, I&apos;ve logged in →
          </button>
        </div>
      </div>
    )
  }

  if (state === 'done') {
    return (
      <div className="flex items-center gap-3 text-success">
        <CheckCircle2 size={16} />
        <span className="text-body font-medium">Logged in</span>
      </div>
    )
  }

  // login-prompt
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-section text-text-1 mb-2">Connect your Claude account</h2>
        <p className="text-body text-text-3">
          career-ops uses Claude Code — your existing Anthropic subscription, no API key needed.
        </p>
      </div>
      <button
        onClick={handleLogin}
        className="flex items-center gap-3 px-4 py-3 bg-accent hover:bg-accent/90 active:scale-95 text-white rounded-md transition-all font-medium text-body"
      >
        Log in with Claude
      </button>
    </div>
  )
}
