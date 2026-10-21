'use client'

import './themes.css'
import './globals.css'
import { useEffect } from 'react'
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google'
import { useAppStore } from '@/store/app'
import { useDataRootStore } from '@/store/dataRoot'
import { useProfilesStore } from '@/store/profiles'
import { launchView } from '@/lib/dataRoot'
import { AppShell } from '@/components/layout/AppShell'
import { OnboardingGate } from '@/components/onboarding/OnboardingGate'
import { TailoringScreen } from '@/components/onboarding/TailoringScreen'
import { PALETTE_BOOT_SCRIPT } from '@/lib/themes'

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
  const initialized = useAppStore(s => s.initialized)
  const isOnboarded = useAppStore(s => s.isOnboarded)
  const tailoringComplete = useAppStore(s => s.tailoringComplete)
  const repoPath = useAppStore(s => s.repoPath)
  const forceOnboarding = useAppStore(s => s.forceOnboarding)
  const dataRoot = useDataRootStore(s => s.info)

  useEffect(() => {
    // Even if init fails, stop showing the blank launch state.
    void init().finally(() => useAppStore.setState({ initialized: true }))
  }, [init])

  // The data moved (demo on/off, private init): re-check "already set up?"
  // for the new root and reload the profile list. The AppShell is keyed on
  // the root below, so every view remounts and re-reads its files.
  const dataKey = dataRoot ? `${dataRoot.kind}:${dataRoot.root ?? ''}` : 'unknown'
  useEffect(() => {
    if (dataKey === 'unknown') return
    void useAppStore.getState().refreshSetup()
    void useProfilesStore.getState().load()
  }, [dataKey])

  // Demo mode never forces onboarding (or tailoring): it goes straight to
  // the app, read-only (lib/dataRoot.ts → needsOnboarding).
  // Nothing renders until init() has read the config ('loading'), so the
  // onboarding gate never flashes before an onboarded app.
  const view = launchView({ initialized, isOnboarded, repoPath, tailoringComplete, forceOnboarding, info: dataRoot })

  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* Colour theme, applied before first paint (lib/themes.ts). The
            static export pre-renders this into the HTML, so the stored
            theme is set before React hydrates. React never renders
            data-palette itself, so it never resets it; with no attribute
            the :root block (the default theme) applies. */}
        <script dangerouslySetInnerHTML={{ __html: PALETTE_BOOT_SCRIPT }} />
        <title>starpath</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        {view === 'loading' ? null
          : view === 'onboarding' ? <OnboardingGate />
          : view === 'tailoring' ? <TailoringScreen />
          : <AppShell key={dataKey} />}
      </body>
    </html>
  )
}
