'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app'
import { StepRepo } from './steps/StepRepo'
import { StepClaude } from './steps/StepClaude'
import { StepCV } from './steps/StepCV'
import { StepProfile } from './steps/StepProfile'
import { StepPortals } from './steps/StepPortals'
import { StarpathLogo } from '@/components/shared/Logos'
import { OrbitingSystem, type OrbiterConfig } from '@/components/ui/orbiting'
import { CelestialSphere } from '@/components/ui/celestial-sphere'
import confetti from 'canvas-confetti'

export type OnboardingStep = 'repo' | 'claude' | 'cv' | 'profile' | 'portals'

const STEPS: { key: OnboardingStep; label: string; description: string }[] = [
  { key: 'repo',    label: 'Select your repo',    description: 'Point the app to your career-ops folder' },
  { key: 'claude',  label: 'Connect Claude',      description: 'Log in with your Anthropic account' },
  { key: 'cv',      label: 'Add your CV',         description: 'Paste your CV to power evaluations' },
  { key: 'profile', label: 'Set up your profile', description: 'Name, targets, comp, and location' },
  { key: 'portals', label: 'Configure portals',   description: 'Keywords and companies to scan' },
]

// Six stars orbiting the StarpathLogo on the finale overlay. Sizes
// alternate so the orbit reads as varied not metronomic; phase shifts
// distribute them evenly around the ring.
const FINALE_STARS: OrbiterConfig[] = [
  { id: 's0', size: 14, phase: 0,                       glow: '#7C5CFF', label: '', content: <StarDot bright /> },
  { id: 's1', size: 10, phase: (1 * Math.PI * 2) / 6,   glow: '#B5A3FF', label: '', content: <StarDot /> },
  { id: 's2', size: 14, phase: (2 * Math.PI * 2) / 6,   glow: '#5B3FE8', label: '', content: <StarDot bright /> },
  { id: 's3', size: 10, phase: (3 * Math.PI * 2) / 6,   glow: '#B5A3FF', label: '', content: <StarDot /> },
  { id: 's4', size: 12, phase: (4 * Math.PI * 2) / 6,   glow: '#7C5CFF', label: '', content: <StarDot /> },
  { id: 's5', size: 10, phase: (5 * Math.PI * 2) / 6,   glow: '#A121CE', label: '', content: <StarDot /> },
]

function StarDot({ bright = false }: { bright?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'block rounded-full',
        bright ? 'w-2 h-2 bg-white' : 'w-1.5 h-1.5 bg-accent-light',
      )}
    />
  )
}

export function OnboardingGate() {
  const { setOnboardingComplete } = useAppStore()
  const [completed, setCompleted] = useState<Set<OnboardingStep>>(new Set())
  const [activeStep, setActiveStep] = useState<OnboardingStep>('repo')
  const [done, setDone] = useState(false)

  const completeStep = (step: OnboardingStep) => {
    const next = new Set(completed)
    next.add(step)
    setCompleted(next)
    const nextStep = STEPS.find(s => !next.has(s.key))
    if (nextStep) setActiveStep(nextStep.key)
    else handleAllDone(next)
  }

  const handleAllDone = async (completedSet: Set<OnboardingStep>) => {
    if (completedSet.size < STEPS.length) return
    setDone(true)
    confetti({
      particleCount: 160,
      spread: 80,
      origin: { y: 0.55 },
      // Galaxy palette only — accent + accent-light + the magenta stop
      // from the wordmark gradient + accent-press for a deeper note +
      // white. The earlier `#C99518` gold was a leftover from the old
      // archetype palette and broke the brand cohesion at the moment of
      // celebration.
      colors: ['#7C5CFF', '#B5A3FF', '#A121CE', '#5B3FE8', '#FFFFFF'],
    })
    setTimeout(async () => {
      await setOnboardingComplete()
    }, 2200)
  }

  return (
    <div className="relative flex h-screen w-screen overflow-hidden galaxy-immersive p-3 gap-3">
      {/* Cosmic backdrop — WebGL celestial sphere shader drifts behind
          the panels. The .galaxy-immersive radial bloom underneath
          provides the brand-tinted base; the shader paints nebula
          clouds and a faint starfield on top, with cursor-driven warp.
          opacity: 0.8 lets the base wash come through so the violet
          identity persists even when the shader is mid-drift. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{ opacity: 0.8, mixBlendMode: 'screen' }}
      >
        <CelestialSphere hue={278} speed={0.16} zoom={1.5} particleSize={2.2} />
      </div>

      {/* Left: progress checklist */}
      <div className="w-[300px] shrink-0 flex flex-col bg-bg-base rounded-xl shadow-card overflow-hidden">
        {/* Title bar — shows the brand mark instead of being empty. The drag
            region still works because the entire bar has -webkit-app-region:
            drag from the .titlebar-drag class. */}
        <div className="titlebar-drag h-11 border-b border-border-default flex items-center px-5 gap-2">
          <StarpathLogo size={16} />
          <span className="text-[15px] tracking-tight galaxy-text font-bold lowercase leading-none titlebar-no-drag select-none">
            starpath
          </span>
        </div>

        <div className="flex-1 px-6 pt-7 pb-6 flex flex-col gap-7">
          <div>
            <h1 className="text-[22px] text-text-1 font-semibold mb-1.5 leading-tight">
              Welcome aboard
            </h1>
            <p className="text-[13px] text-text-3 leading-snug">
              Five short steps to set up your job-search workspace. Anything you
              add now you can change later from Settings.
            </p>
          </div>

          <div className="space-y-1.5">
            {STEPS.map((step, i) => {
              const isDone = completed.has(step.key)
              const isActive = activeStep === step.key && !isDone
              return (
                <button
                  key={step.key}
                  onClick={() => setActiveStep(step.key)}
                  className={cn(
                    'w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg transition-all duration-200',
                    isActive
                      ? 'bg-accent/10 border border-accent/30'
                      : isDone
                        ? 'hover:bg-bg-elevated'
                        : 'hover:bg-bg-elevated border border-transparent',
                  )}
                >
                  <div className="mt-0.5 shrink-0">
                    {isDone ? (
                      <CheckCircle2 size={17} className="text-success" />
                    ) : isActive ? (
                      <span className="relative inline-flex w-[17px] h-[17px] items-center justify-center">
                        <span className="absolute inset-0 rounded-full border-2 border-accent" />
                        <span className="absolute inset-0 rounded-full border-2 border-accent animate-ping opacity-70" />
                        <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                      </span>
                    ) : (
                      <Circle size={17} className="text-text-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={cn(
                      'text-[13px] font-medium transition-colors',
                      isDone ? 'text-text-3' : isActive ? 'text-text-1' : 'text-text-2',
                    )}>
                      <span className="text-text-4 font-mono mr-1.5">{i + 1}.</span>
                      {step.label}
                    </div>
                    {(isActive || (!isDone && !isActive)) && (
                      <div className="text-[11.5px] text-text-4 mt-0.5 leading-snug">
                        {step.description}
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Progress bar */}
          <div className="mt-auto">
            <div className="flex justify-between text-[10px] text-text-4 mb-1.5 uppercase tracking-wider font-medium">
              <span>Progress</span>
              <span className="font-mono text-text-3">{completed.size} / {STEPS.length}</span>
            </div>
            <div className="h-1 bg-border-default rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-accent rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${(completed.size / STEPS.length) * 100}%` }}
                transition={{ type: 'spring', stiffness: 200, damping: 22 }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Right: step content (full width — no more locked-features pane) */}
      <div className="relative flex-1 flex flex-col bg-bg-base rounded-xl shadow-card overflow-hidden">
        <div className="titlebar-drag h-11 border-b border-border-default shrink-0 flex items-center justify-between px-5">
          <span className="text-[10px] uppercase tracking-[0.14em] text-text-4 font-semibold titlebar-no-drag">
            Step {STEPS.findIndex(s => s.key === activeStep) + 1} of {STEPS.length}
          </span>
          <span className="text-[10px] text-text-4 titlebar-no-drag tabular-nums">
            {Math.round((completed.size / STEPS.length) * 100)}% complete
          </span>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[560px] mx-auto px-10 py-12">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeStep}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
              >
                {activeStep === 'repo'    && <StepRepo    onComplete={() => completeStep('repo')}    />}
                {activeStep === 'claude'  && <StepClaude  onComplete={() => completeStep('claude')}  />}
                {activeStep === 'cv'      && <StepCV      onComplete={() => completeStep('cv')}      />}
                {activeStep === 'profile' && <StepProfile onComplete={() => completeStep('profile')} />}
                {activeStep === 'portals' && <StepPortals onComplete={() => completeStep('portals')} />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* Done overlay — celebration with the starpath mark */}
        <AnimatePresence>
          {done && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="absolute inset-0 flex items-center justify-center backdrop-blur-md z-50"
              style={{
                background:
                  'radial-gradient(ellipse at 50% 45%, rgba(124,92,255,0.18) 0%, rgba(255,255,255,0.85) 60%)',
              }}
            >
              <motion.div
                initial={{ scale: 0.85, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 20 }}
                className="text-center px-8"
              >
                {/* Constellation snap-in — your starpath ignites. The
                    StarpathLogo sits at center; six small violet stars
                    orbit around it. The orbit metaphor lands here at
                    the moment of brand reveal: you've configured your
                    coordinates, now your galaxy lights up. */}
                <motion.div
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.25, type: 'spring', stiffness: 180, damping: 24 }}
                  className="inline-block mb-5"
                  style={{ filter: 'drop-shadow(0 8px 28px rgba(124,92,255,0.45))' }}
                >
                  <OrbitingSystem
                    size={240}
                    innerRadius={92}
                    innerSpeed={0.28}
                    innerOrbit={FINALE_STARS}
                    center={<StarpathLogo size={56} />}
                  />
                </motion.div>
                <h2 className="text-[28px] font-bold leading-tight mb-2 galaxy-text">
                  You&apos;re all set
                </h2>
                <p className="text-body text-text-3">
                  Tailoring your workspace…
                </p>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
