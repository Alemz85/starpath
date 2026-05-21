'use client'

import './globals.css'
import { useEffect } from 'react'
import { useAppStore } from '@/store/app'
import { AppShell } from '@/components/layout/AppShell'
import { OnboardingGate } from '@/components/onboarding/OnboardingGate'
import { TailoringScreen } from '@/components/onboarding/TailoringScreen'

export default function RootLayout({ children: _children }: { children: React.ReactNode }) {
  const init = useAppStore(s => s.init)
  const isOnboarded = useAppStore(s => s.isOnboarded)
  const tailoringComplete = useAppStore(s => s.tailoringComplete)
  const repoPath = useAppStore(s => s.repoPath)

  useEffect(() => {
    init()
  }, [init])

  const needsOnboarding = !isOnboarded || !repoPath
  const needsTailoring  = isOnboarded && !!repoPath && !tailoringComplete

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <title>career-ops</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        {needsOnboarding ? (
          <OnboardingGate />
        ) : needsTailoring ? (
          <TailoringScreen />
        ) : (
          <AppShell />
        )}
      </body>
    </html>
  )
}
