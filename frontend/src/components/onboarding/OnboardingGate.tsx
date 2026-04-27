'use client'

import { useState, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Circle, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app'
import { StepRepo } from './steps/StepRepo'
import { StepClaude } from './steps/StepClaude'
import { StepCV } from './steps/StepCV'
import { StepProfile } from './steps/StepProfile'
import { StepPortals } from './steps/StepPortals'
import confetti from 'canvas-confetti'

export type OnboardingStep = 'repo' | 'claude' | 'cv' | 'profile' | 'portals'

const STEPS: { key: OnboardingStep; label: string; description: string }[] = [
  { key: 'repo',    label: 'Select your repo',       description: 'Point the app to your career-ops folder' },
  { key: 'claude',  label: 'Connect Claude',          description: 'Log in with your Anthropic account' },
  { key: 'cv',      label: 'Add your CV',             description: 'Paste your CV to power evaluations' },
  { key: 'profile', label: 'Set up your profile',     description: 'Name, targets, comp, and location' },
  { key: 'portals', label: 'Configure portals',       description: 'Keywords and companies to scan' },
]

const FEATURE_CARDS = [
  'Command Center', 'Database', 'Reports',
  'Pipeline', 'Trends', 'Scan', 'Settings',
]

export function OnboardingGate() {
  const { setOnboardingComplete } = useAppStore()
  const [completed, setCompleted] = useState<Set<OnboardingStep>>(new Set())
  const [activeStep, setActiveStep] = useState<OnboardingStep>('repo')
  const [done, setDone] = useState(false)

  const allDone = completed.size === STEPS.length

  const completeStep = (step: OnboardingStep) => {
    const next = new Set(completed)
    next.add(step)
    setCompleted(next)

    // Auto-advance to next incomplete step
    const nextStep = STEPS.find(s => !next.has(s.key))
    if (nextStep) setActiveStep(nextStep.key)
    else handleAllDone(next)
  }

  const handleAllDone = async (completedSet: Set<OnboardingStep>) => {
    if (completedSet.size < STEPS.length) return
    setDone(true)
    confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 }, colors: ['#0064E0', '#47A5FA', '#C99518'] })
    setTimeout(async () => {
      await setOnboardingComplete()
    }, 1800)
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-base galaxy-bg">
      {/* Left: checklist */}
      <div className="w-80 shrink-0 flex flex-col border-r border-border-default bg-bg-chrome/60">
        <div className="titlebar-drag h-11 border-b border-border-default" />

        <div className="flex-1 p-6 flex flex-col gap-6">
          <div>
            <h1 className="text-section text-text-1 mb-1">Welcome to career-ops</h1>
            <p className="text-label text-text-3">Complete 5 steps to unlock all features.</p>
          </div>

          <div className="space-y-2">
            {STEPS.map((step, i) => {
              const isDone = completed.has(step.key)
              const isActive = activeStep === step.key && !isDone
              const isPast = Array.from(completed).includes(step.key)

              return (
                <button
                  key={step.key}
                  onClick={() => setActiveStep(step.key)}
                  className={cn(
                    'w-full text-left flex items-start gap-3 p-3 rounded-lg transition-colors',
                    isActive ? 'bg-accent/15 border border-accent/30' : 'hover:bg-bg-elevated',
                  )}
                >
                  <div className="mt-0.5 shrink-0">
                    {isDone ? (
                      <CheckCircle2 size={16} className="text-success" />
                    ) : isActive ? (
                      <div className="w-4 h-4 rounded-full border-2 border-accent flex items-center justify-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent" />
                      </div>
                    ) : (
                      <Circle size={16} className="text-text-4" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className={cn('text-body', isDone ? 'text-text-2 line-through' : isActive ? 'text-text-1' : 'text-text-3')}>
                      {i + 1}. {step.label}
                    </div>
                    {isActive && (
                      <div className="text-label text-text-3 mt-0.5">{step.description}</div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Progress bar */}
          <div className="mt-auto">
            <div className="flex justify-between text-micro text-text-4 mb-2">
              <span>PROGRESS</span>
              <span>{completed.size} / {STEPS.length}</span>
            </div>
            <div className="h-1 bg-border-default rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-accent rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${(completed.size / STEPS.length) * 100}%` }}
                transition={{ type: 'spring', stiffness: 200, damping: 20 }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Right: step content */}
      <div className="flex-1 flex flex-col">
        <div className="titlebar-drag h-11 border-b border-border-default shrink-0" />

        <div className="flex-1 flex overflow-hidden">
          {/* Step wizard */}
          <div className="flex-1 flex flex-col p-8 overflow-y-auto">
            <div className="max-w-xl">
              {activeStep === 'repo'    && <StepRepo    onComplete={() => completeStep('repo')}    />}
              {activeStep === 'claude'  && <StepClaude  onComplete={() => completeStep('claude')}  />}
              {activeStep === 'cv'      && <StepCV      onComplete={() => completeStep('cv')}      />}
              {activeStep === 'profile' && <StepProfile onComplete={() => completeStep('profile')} />}
              {activeStep === 'portals' && <StepPortals onComplete={() => completeStep('portals')} />}
            </div>
          </div>

          {/* Locked features preview */}
          <div className="w-64 shrink-0 border-l border-border-default p-4">
            <p className="text-micro text-text-4 uppercase mb-3">Features unlocking</p>
            <div className="grid grid-cols-2 gap-2">
              {FEATURE_CARDS.map(name => (
                <div
                  key={name}
                  className="flex flex-col items-center gap-1.5 p-3 rounded-lg bg-bg-panel border border-border-default opacity-40"
                >
                  <Lock size={14} className="text-text-4" />
                  <span className="text-label text-text-3 text-center leading-tight">{name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Done overlay */}
        <AnimatePresence>
          {done && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="absolute inset-0 bg-bg-base/80 flex items-center justify-center backdrop-blur-sm z-50"
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.1 }}
                className="text-center"
              >
                <CheckCircle2 size={48} className="text-success mx-auto mb-4" />
                <h2 className="text-page text-text-1 mb-2">You&apos;re all set!</h2>
                <p className="text-body text-text-3">Opening career-ops&hellip;</p>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
