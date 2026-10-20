'use client'

import { AlertCircle, ArrowRight, Loader2, Rocket, Telescope } from 'lucide-react'
import { cn } from '@/lib/utils'

// The first onboarding screen: look around the fictional demo (read-only,
// nothing to set up) or start the setup wizard for your own search. The demo
// card only renders when the checkout ships a demo/ folder.
export function StepChoice({
  demoAvailable,
  busy,
  error,
  onDemo,
  onOwn,
}: {
  demoAvailable: boolean
  busy: boolean
  error: string | null
  onDemo: () => void
  onOwn: () => void
}) {
  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-[26px] font-semibold text-text-1 leading-tight mb-3">
          How do you want to start?
        </h2>
        <p className="text-[14px] text-text-3 leading-relaxed">
          Look around a finished job search first, or set up your own. You can
          switch between the two any time from Settings › General.
        </p>
      </div>

      <div className="grid gap-3">
        {demoAvailable && (
          <ChoiceCard
            icon={Telescope}
            title="Explore the demo"
            body="A fictional candidate's search: scored listings, reports, applications and outreach. Read-only, and nothing to set up."
            cta="Open the demo"
            onClick={onDemo}
            disabled={busy}
            loading={busy}
          />
        )}
        <ChoiceCard
          icon={Rocket}
          title="Set up my own search"
          body="Five short steps: your CV, your profile and the companies to scan. Everything you add stays in a private folder in this checkout, never in the public repo."
          cta="Start setup"
          onClick={onOwn}
          disabled={busy}
          primary
        />
      </div>

      {error && (
        <div className="flex items-start gap-2.5 p-3.5 rounded-lg border bg-danger/10 border-danger/30 text-danger text-[12.5px]" role="alert">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}
    </div>
  )
}

function ChoiceCard({
  icon: Icon, title, body, cta, onClick, disabled, loading, primary,
}: {
  icon: React.ElementType
  title: string
  body: string
  cta: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  primary?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group w-full text-left rounded-lg border p-4 flex items-start gap-3.5 transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60',
        primary
          ? 'border-accent/30 bg-accent/10 hover:border-accent/50'
          : 'border-border-default bg-bg-elevated/60 hover:border-accent/30',
      )}
    >
      <span className={cn(
        'shrink-0 w-9 h-9 rounded-full flex items-center justify-center',
        primary ? 'bg-accent text-white' : 'bg-bg-base text-accent border border-border-default',
      )}>
        <Icon size={17} aria-hidden />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[15px] font-semibold text-text-1 mb-1">{title}</span>
        <span className="block text-[12.5px] text-text-3 leading-relaxed">{body}</span>
        <span className="mt-2.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent-text">
          {loading ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
          {cta}
          {!loading && <ArrowRight size={13} className="transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />}
        </span>
      </span>
    </button>
  )
}
