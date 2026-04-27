'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, Sparkles, AlertCircle } from 'lucide-react'
import { useAppStore } from '@/store/app'
import { ipc } from '@/lib/ipc'

type State = 'running' | 'done' | 'error'
const SPAWN_ID = 'tailoring-main'

const MESSAGES = [
  'Reading your CV and profile…',
  'Analyzing your target roles…',
  'Building keyword filters…',
  'Generating candidate context…',
  'Writing your workspace files…',
]

export function TailoringScreen() {
  const { setTailoringComplete } = useAppStore()
  const [state, setState] = useState<State>('running')
  const [output, setOutput] = useState<string[]>([])
  const [msgIndex, setMsgIndex] = useState(0)
  const logRef = useRef<HTMLDivElement>(null)
  const doneRef = useRef(false)

  // Cycle status messages while running
  useEffect(() => {
    if (state !== 'running') return
    const t = setInterval(() => {
      setMsgIndex(i => (i + 1) % MESSAGES.length)
    }, 2800)
    return () => clearInterval(t)
  }, [state])

  useEffect(() => {
    ipc.spawn(SPAWN_ID, 'claude', ['-p', '@.claude/skills/career-ops-setup/SKILL.md'])

    const unsubOut = ipc.onSpawnOutput((id, chunk) => {
      if (id !== SPAWN_ID) return
      setOutput(prev => [...prev, chunk])
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    })

    const unsubDone = ipc.onSpawnDone((id, code) => {
      if (id !== SPAWN_ID || doneRef.current) return
      doneRef.current = true
      setState(code === 0 ? 'done' : 'error')
      if (code === 0) {
        setTimeout(() => setTailoringComplete(), 1600)
      }
    })

    return () => { unsubOut?.(); unsubDone?.() }
  }, [setTailoringComplete])

  return (
    <div className="flex h-screen w-screen overflow-hidden galaxy-immersive items-center justify-center">
      <div className="titlebar-drag absolute top-0 inset-x-0 h-11" />

      <div className="flex flex-col items-center gap-7 w-full max-w-md px-8">
        {/* Animated icon */}
        <div className="relative flex items-center justify-center">
          {state === 'running' && (
            <motion.div
              className="absolute inset-0 rounded-2xl border-2"
              style={{ width: 72, height: 72, margin: 'auto', borderColor: 'rgba(124,92,255,0.55)' }}
              animate={{ scale: [1, 1.25, 1], opacity: [0.6, 0, 0.6] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}
          <motion.div
            animate={state === 'running' ? { opacity: [0.7, 1, 0.7] } : { opacity: 1 }}
            transition={{ duration: 2, repeat: state === 'running' ? Infinity : 0, ease: 'easeInOut' }}
            className="w-[72px] h-[72px] rounded-2xl flex items-center justify-center"
            style={{ background: 'rgba(124,92,255,0.18)', border: '1px solid rgba(124,92,255,0.35)' }}
          >
            {state === 'done' ? (
              <CheckCircle2 size={32} className="text-success" />
            ) : state === 'error' ? (
              <AlertCircle size={32} className="text-warning" />
            ) : (
              <Sparkles size={30} style={{ color: '#B5A3FF' }} />
            )}
          </motion.div>
        </div>

        {/* Status text */}
        <div className="text-center space-y-2">
          <h2 className="text-section text-white">
            {state === 'running' && 'Claude is tailoring your workspace'}
            {state === 'done'    && 'Workspace ready'}
            {state === 'error'   && 'Setup complete'}
          </h2>
          <motion.p
            key={state === 'running' ? msgIndex : state}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="text-label text-white/70"
          >
            {state === 'running' && MESSAGES[msgIndex]}
            {state === 'done'    && 'Your workspace has been personalized for your target roles.'}
            {state === 'error'   && 'Tailoring could not complete — you can re-tune from Settings anytime.'}
          </motion.p>
        </div>

        {/* Log output — compact scrollable */}
        {output.length > 0 && (
          <div
            ref={logRef}
            className="w-full max-h-32 overflow-y-auto rounded-lg px-3 py-2 font-mono text-[11px] leading-relaxed"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.6)' }}
          >
            {output.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
            ))}
          </div>
        )}

        {state === 'error' && (
          <button
            onClick={() => setTailoringComplete()}
            className="btn-pill-outline"
            style={{ color: '#FFFFFF', borderColor: 'rgba(255,255,255,0.25)' }}
          >
            Continue to app
          </button>
        )}
      </div>
    </div>
  )
}
