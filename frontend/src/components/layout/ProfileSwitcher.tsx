'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNavStore } from '@/store/nav'
import { useProfilesStore } from '@/store/profiles'
import { profileInitial, formatProfileCounts, type ProfileInfo } from '@/lib/profiles'
import { OrbitalLoader } from '@/components/ui/orbital-loader'

// Workspace switcher — sits directly under the wordmark row in the sidebar.
// Expanded: a full-width row (same visual weight as the Search row below it)
// showing the active profile; collapsed: the profile initial in a circle.
// Click → popover listing every profile with counts, switch on click, plus a
// "New profile…" jump to the Settings profiles section. Hidden entirely on
// pre-migration repos (profile:list reports no profiles).

const POPOVER_WIDTH = 240

function InitialCircle({ profile, size = 18 }: { profile: { label?: string; slug: string }; size?: number }) {
  return (
    <span
      className="rounded-full bg-accent/15 text-accent-text font-semibold flex items-center justify-center shrink-0"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      aria-hidden
    >
      {profileInitial(profile)}
    </span>
  )
}

export function ProfileSwitcher({ expanded }: { expanded: boolean }) {
  const profiles = useProfilesStore(s => s.profiles)
  const loaded = useProfilesStore(s => s.loaded)
  const switching = useProfilesStore(s => s.switching)
  const lastFailure = useProfilesStore(s => s.lastFailure)
  const load = useProfilesStore(s => s.load)
  const switchTo = useProfilesStore(s => s.switchTo)
  const navigate = useNavStore(s => s.navigate)

  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => { void load() }, [load])

  // The anchor is measured at open time — a width toggle invalidates it.
  useEffect(() => { setOpen(false) }, [expanded])

  // Outside-click (deferred so the opening click doesn't instantly close)
  // + Escape — same idiom as RowActionPopover.
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDocMouseDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!loaded || profiles.length === 0) return null

  const active = profiles.find(p => p.active) ?? null

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const vh = window.innerHeight
      const raw = expanded
        ? { left: Math.round(r.left), top: Math.round(r.bottom + 6) }
        : { left: Math.round(r.right + 8), top: Math.round(r.top) }
      // Rough clamp so a long list near the bottom edge stays on screen;
      // the list itself scrolls past ~6 profiles.
      setAnchor({ left: raw.left, top: Math.min(raw.top, Math.max(8, vh - 360)) })
    }
    setOpen(o => !o)
  }

  const handleSwitch = async (p: ProfileInfo) => {
    if (p.active) return
    const res = await switchTo(p.slug)
    if (res.ok) setOpen(false)
    // On refusal the popover stays open — lastFailure renders below the list.
  }

  return (
    <div className={cn('pt-2', expanded ? 'px-3' : 'px-2 flex justify-center')}>
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={!!switching}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={active ? `Profile: ${active.label || active.slug}` : 'Profiles'}
        title={!expanded ? (active ? active.label || active.slug : 'Profiles') : undefined}
        className={cn(
          'flex items-center rounded-md bg-bg-base border border-border-default text-text-2 hover:text-text-1 transition-colors text-label disabled:opacity-60',
          expanded ? 'w-full gap-2 px-2 py-1.5' : 'w-9 h-9 justify-center',
        )}
      >
        {switching
          ? <OrbitalLoader size={16} rings={2} />
          : active
            ? <InitialCircle profile={active} />
            : <span className="text-text-4">—</span>}
        {expanded && (
          <>
            <span className="flex-1 text-left truncate">
              {switching ? 'Switching…' : active ? active.label || active.slug : 'no active profile'}
            </span>
            <ChevronDown
              size={12}
              className={cn('text-text-4 shrink-0 transition-transform duration-200 ease-quart', open && 'rotate-180')}
            />
          </>
        )}
      </button>

      {open && anchor && (
        <div
          ref={popRef}
          role="menu"
          aria-label="Profiles"
          className="fixed z-50 rounded-lg border border-border-strong bg-bg-base shadow-lift overflow-hidden"
          style={{ left: anchor.left, top: anchor.top, width: POPOVER_WIDTH, animation: 'chip-appear 160ms ease both' }}
        >
          <div className="px-3 pt-2 pb-1 text-micro text-text-4 uppercase">Profiles</div>
          <div className="max-h-60 overflow-y-auto pb-1">
            {profiles.map(p => (
              <button
                key={p.slug}
                role="menuitem"
                disabled={!!switching || p.active}
                onClick={() => void handleSwitch(p)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors',
                  p.active ? 'cursor-default' : 'hover:bg-bg-elevated',
                  switching && switching !== p.slug && 'opacity-50',
                )}
              >
                <InitialCircle profile={p} />
                <span className="flex-1 min-w-0">
                  <span className="block text-label text-text-1 font-medium truncate">{p.label || p.slug}</span>
                  <span className="block text-[10px] text-text-4 truncate">{formatProfileCounts(p.counts)}</span>
                </span>
                {p.active && <Check size={12} className="text-accent shrink-0" aria-label="Active profile" />}
                {switching === p.slug && <OrbitalLoader size={14} rings={2} className="shrink-0" />}
              </button>
            ))}
          </div>

          {lastFailure && (
            <div className="px-3 py-2 border-t border-border-default" role="alert">
              <p className="text-[11px] font-medium text-danger">Switch to {lastFailure.slug} refused</p>
              {lastFailure.lines.map((line, i) => (
                <p key={i} className="text-[11px] text-danger/80 leading-snug mt-0.5">{line}</p>
              ))}
            </div>
          )}

          <div className="border-t border-border-default py-1">
            <button
              role="menuitem"
              onClick={() => { setOpen(false); navigate('settings') }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-label text-text-3 hover:text-text-1 hover:bg-bg-elevated transition-colors"
            >
              <Plus size={12} className="shrink-0" aria-hidden />
              New profile…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
