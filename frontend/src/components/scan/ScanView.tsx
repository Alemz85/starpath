'use client'

import { useState, useRef, useEffect } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { ipc } from '@/lib/ipc'
import { Radar, Play, Square, RotateCcw, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'

type ScanStatus = 'idle' | 'running' | 'done' | 'error'
type ScanMode = 'full' | 'api'

const SPAWN_ID = 'scan-main'

export function ScanView() {
  const { repoPath } = useAppStore()
  const { refresh } = useDataStore()
  const [status, setStatus] = useState<ScanStatus>('idle')
  const [mode, setMode] = useState<ScanMode>('full')
  const [output, setOutput] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    const unsubOut = ipc.onSpawnOutput((id, chunk) => {
      if (id !== SPAWN_ID) return
      setOutput(prev => [...prev, chunk])
    })
    const unsubDone = ipc.onSpawnDone((id, code) => {
      if (id !== SPAWN_ID) return
      setStatus(code === 0 ? 'done' : 'error')
      refresh()
    })
    return () => { unsubOut?.(); unsubDone?.() }
  }, [refresh])

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [output, autoScroll])

  const runScan = (scanMode: ScanMode) => {
    if (!repoPath) return
    setOutput([])
    setStatus('running')
    setMode(scanMode)
    if (scanMode === 'api') {
      ipc.spawn(SPAWN_ID, 'node', ['scan.mjs'])
    } else {
      // Full scan: Claude reads scan.md and runs Playwright + API + WebSearch
      ipc.spawn(SPAWN_ID, 'claude', ['-p', '@modes/scan.md'])
    }
  }

  const stopScan = () => {
    ipc.kill(SPAWN_ID)
    setStatus('idle')
  }

  const isRunning = status === 'running'

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="titlebar-drag h-11 shrink-0 border-b border-border-default" />

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-default bg-bg-chrome shrink-0">
        <h1 className="text-body text-text-1 font-medium">Scan</h1>
        <span className={cn(
          'text-micro font-mono px-2 py-0.5 rounded-full border',
          status === 'idle'    && 'text-text-4 border-border-default',
          status === 'running' && 'text-accent border-accent/40 bg-accent/10',
          status === 'done'    && 'text-success border-success/40 bg-success/10',
          status === 'error'   && 'text-danger border-danger/40 bg-danger/10',
        )}>
          {isRunning ? `${mode === 'full' ? 'full' : 'api'} · running` : status}
        </span>
        <div className="flex-1" />

        {isRunning ? (
          <button
            onClick={stopScan}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-danger/20 text-danger border border-danger/30 text-label hover:bg-danger/30 transition-colors"
          >
            <Square size={12} />
            Stop
          </button>
        ) : (
          <div className="flex items-center gap-2">
            {/* Primary: Full scan */}
            <button
              onClick={() => runScan('full')}
              disabled={!repoPath}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent/20 text-accent-text border border-accent/30 text-label hover:bg-accent/30 disabled:opacity-40 transition-colors"
              title="Playwright + API + WebSearch — uses Claude (token cost)"
            >
              <Play size={12} />
              Full Scan
            </button>

            {/* Secondary: API only */}
            <button
              onClick={() => runScan('api')}
              disabled={!repoPath}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg-elevated text-text-3 border border-border-default text-label hover:text-text-2 hover:border-border-strong disabled:opacity-40 transition-colors"
              title="Direct API calls only — zero token cost"
            >
              <Zap size={12} />
              API Only
            </button>

          </div>
        )}

        {!isRunning && output.length > 0 && (
          <button
            onClick={() => { setOutput([]); setStatus('idle') }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-text-4 hover:text-text-2 border border-border-default text-label transition-colors"
          >
            <RotateCcw size={12} />
            Clear
          </button>
        )}
      </div>

      {/* Idle explanation */}
      {status === 'idle' && output.length === 0 && (
        <div className="px-6 py-8 space-y-6">
          <div className="text-center space-y-2">
            <Radar size={40} className="text-text-4 mx-auto opacity-30" />
            <p className="text-body text-text-2 font-medium">Portal Scanner</p>
            <p className="text-label text-text-4">
              Configure companies and keywords in <code className="text-accent text-micro">user/portals.yml</code>
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 max-w-lg mx-auto">
            <div className="p-4 bg-bg-panel border border-accent/30 rounded-lg space-y-1.5">
              <div className="flex items-center gap-2">
                <Play size={13} className="text-accent" />
                <span className="text-body text-text-1 font-medium">Full Scan</span>
              </div>
              <p className="text-label text-text-3 leading-snug">
                Playwright + ATS APIs + WebSearch. Covers all tracked companies including those
                without a public API. Uses Claude (token cost).
              </p>
            </div>
            <div className="p-4 bg-bg-panel border border-border-default rounded-lg space-y-1.5">
              <div className="flex items-center gap-2">
                <Zap size={13} className="text-text-3" />
                <span className="text-body text-text-1 font-medium">API Only</span>
              </div>
              <p className="text-label text-text-3 leading-snug">
                Direct API calls to Greenhouse, Ashby, Lever, Workday, SmartRecruiters.
                Zero token cost — instant and free.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Log output */}
      {(isRunning || output.length > 0) && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-4 py-1.5 border-b border-border-default bg-bg-chrome shrink-0">
            <span className="text-micro text-text-4 uppercase">Output</span>
            <label className="flex items-center gap-1.5 text-micro text-text-4 cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={e => setAutoScroll(e.target.checked)}
                className="accent-[#7C5CFF] w-3 h-3"
              />
              Auto-scroll
            </label>
          </div>
          <div
            ref={logRef}
            className="flex-1 overflow-y-auto p-4 font-mono text-[12px] leading-relaxed bg-bg-base"
            style={{ userSelect: 'text' }}
          >
            {output.map((line, i) => (
              <div key={i} className={cn(
                'whitespace-pre-wrap break-all',
                line.includes('ERROR') || line.includes('error') ? 'text-danger' :
                line.includes('WARN')  || line.includes('warn')  ? 'text-warning' :
                line.includes('✓')     || line.includes('found') ? 'text-success' :
                'text-text-3',
              )}>
                {line}
              </div>
            ))}
            {isRunning && (
              <div className="flex items-center gap-1.5 text-accent mt-1">
                <span className="inline-block w-1.5 h-3 bg-accent animate-pulse rounded-sm" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
