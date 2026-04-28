'use client'

import { useState, useEffect, useRef } from 'react'
import { Loader2, ExternalLink, CheckCircle2, AlertTriangle } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useAppStore } from '@/store/app'
import { ClaudeLogo } from '@/components/shared/Logos'

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
      if (pollRef.current)  clearInterval(pollRef.current)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runCheck = async () => {
    setState('checking')
    const installed = await recheckClaude()
    if (!installed) { setState('not-installed'); return }
    const { authenticated } = await ipc.checkClaudeAuth()
    if (authenticated) {
      setState('done')
      setTimeout(onComplete, 700)
    } else {
      setState('login-prompt')
    }
  }

  const handleLogin = async () => {
    setState('waiting')
    await ipc.runClaudeLogin()
    pollRef.current = setInterval(async () => {
      const { authenticated } = await ipc.checkClaudeAuth()
      if (authenticated) {
        if (pollRef.current)  clearInterval(pollRef.current)
        if (timerRef.current) clearTimeout(timerRef.current)
        setState('done')
        setTimeout(onComplete, 700)
      }
    }, POLL_INTERVAL)
    timerRef.current = setTimeout(() => {
      if (pollRef.current) clearInterval(pollRef.current)
      setState('login-prompt')
    }, POLL_TIMEOUT)
  }

  const handleManualConfirm = async () => {
    if (pollRef.current) clearInterval(pollRef.current)
    const { authenticated } = await ipc.checkClaudeAuth()
    if (authenticated) { setState('done'); setTimeout(onComplete, 700) }
    else onComplete()
  }

  const handleRecheck = async () => {
    setRechecking(true)
    await recheckClaude()
    setRechecking(false)
    runCheck()
  }

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-[26px] font-semibold text-text-1 leading-tight mb-3">
          Sign in to Claude
        </h2>
        <p className="text-[14px] text-text-3 leading-relaxed">
          starpath does its evaluation work through Claude Code — your existing
          Anthropic subscription, no API key needed. Sign in once and the rest
          of the app uses that session.
        </p>
      </div>

      {state === 'checking' && (
        <div className="rounded-lg border border-border-default bg-bg-elevated/60 px-4 py-3.5 flex items-center gap-3 text-text-3">
          <Loader2 size={15} className="animate-spin" />
          <span className="text-[13px]">Checking your login status…</span>
        </div>
      )}

      {state === 'not-installed' && (
        <>
          <div className="rounded-lg p-4 bg-warning/10 border border-warning/30 flex items-start gap-3">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <div className="text-[13px] text-warning leading-relaxed">
              <p className="font-medium mb-0.5">Claude Code isn&apos;t installed yet</p>
              <p className="text-warning/80">
                Install the CLI first, then come back and re-check.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={handleRecheck}
              disabled={rechecking}
              className="inline-flex items-center gap-2 px-4 h-9 bg-bg-elevated border border-border-default hover:border-accent text-text-2 rounded-pill text-[13px] transition-colors disabled:opacity-50"
            >
              {rechecking && <Loader2 size={13} className="animate-spin" />}
              {rechecking ? 'Checking…' : 'Re-check'}
            </button>
            <a
              href="https://claude.ai/download"
              onClick={e => { e.preventDefault(); ipc.openExternal('https://claude.ai/download') }}
              className="inline-flex items-center gap-1.5 text-accent hover:text-accent-hover text-[13px] transition-colors"
            >
              Download Claude Code <ExternalLink size={12} />
            </a>
          </div>
        </>
      )}

      {state === 'login-prompt' && (
        <button
          onClick={handleLogin}
          className="inline-flex items-center gap-3 pl-2 pr-5 py-2 bg-accent hover:bg-accent-hover active:scale-[0.98] text-white rounded-pill transition-all font-medium text-[14px] shadow-[0_2px_10px_rgba(124,92,255,0.25)]"
        >
          <span className="bg-white rounded-full p-1.5"><ClaudeLogo size={16} /></span>
          Sign in with Claude
        </button>
      )}

      {state === 'waiting' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-accent/30 bg-accent/8 px-4 py-3.5 flex items-center gap-3 text-text-1">
            <Loader2 size={15} className="animate-spin text-accent" />
            <span className="text-[13px]">Browser opened — finish the login and come back. We&apos;ll detect it automatically.</span>
          </div>
          <button
            onClick={handleManualConfirm}
            className="text-[13px] text-accent hover:text-accent-hover transition-colors font-medium"
          >
            Done, I&apos;ve logged in →
          </button>
        </div>
      )}

      {state === 'done' && (
        <div className="rounded-lg border border-success/30 bg-success/8 p-5 flex items-center gap-4">
          <span className="relative inline-flex">
            <span
              className="absolute inset-[-6px] rounded-full animate-pulse"
              style={{ boxShadow: '0 0 0 4px rgba(0,125,30,0.18), 0 0 14px 4px rgba(0,125,30,0.22)' }}
              aria-hidden
            />
            <CheckCircle2 size={26} className="text-success relative" />
          </span>
          <div>
            <div className="text-[15px] text-text-1 font-semibold">Signed in to Claude</div>
            <div className="text-[12.5px] text-text-3 mt-0.5">All set — you can move on to the next step.</div>
          </div>
        </div>
      )}
    </div>
  )
}
