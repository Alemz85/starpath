'use client'

import './globals.css'
import { useEffect } from 'react'
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google'
import { useAppStore } from '@/store/app'
import { AppShell } from '@/components/layout/AppShell'
import { OnboardingGate } from '@/components/onboarding/OnboardingGate'
import { TailoringScreen } from '@/components/onboarding/TailoringScreen'

// Self-hosted through next/font: downloaded at build time, served from
// _next/static, no runtime request to Google. The CSS variables feed
// tailwind.config.ts (`font-sans` / `font-mono`).
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
})
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

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
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <title>starpath</title>
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
