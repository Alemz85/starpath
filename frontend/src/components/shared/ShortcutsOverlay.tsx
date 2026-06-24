'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { useNavStore } from '@/store/nav'
import {
  reduceChord,
  shortcutGroups,
  IDLE_CHORD,
  type ChordState,
  type ShortcutRow,
} from '@/lib/shortcuts'

// Don't hijack keys while the user is typing — into a form field, a
// contenteditable surface, or the ⌘K palette input (which holds focus while
// open, so the `g` chord is naturally inert there).
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/**
 * App-wide keyboard layer: GitHub/Linear-style `g`+letter navigation chords
 * (see lib/shortcuts) plus a `?` cheatsheet. Mounted once in AppShell next to
 * <CmdK />. The chord matching itself is the pure reduceChord state machine; we
 * just hold the leader state in a ref and translate results into navigation.
 */
export function ShortcutsOverlay() {
  const navigate = useNavStore(s => s.navigate)
  const [open, setOpen] = useState(false)
  const chord = useRef<ChordState>(IDLE_CHORD)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Leave modifier combos (⌘K, ⌘C, …) and typing untouched. Shift is
      // allowed through because `?` is Shift+/ and chords may be shifted.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return

      // `?` toggles the cheatsheet from anywhere, and cancels a pending chord.
      if (e.key === '?') {
        e.preventDefault()
        chord.current = IDLE_CHORD
        setOpen(o => !o)
        return
      }

      // While the panel is open it owns the keyboard: Esc closes, nothing else.
      if (open) {
        if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
        return
      }

      const result = reduceChord(chord.current, e.key, Date.now())
      switch (result.type) {
        case 'leader':
        case 'reset':
          chord.current = result.next
          break
        case 'navigate':
          chord.current = result.next
          e.preventDefault()
          navigate(result.view)
          break
        case 'ignore':
          break
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [navigate, open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onClick={() => setOpen(false)}
      style={{ animation: 'chip-appear 160ms ease both' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-[460px] rounded-xl bg-bg-panel border border-border-strong shadow-lift overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4 flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/10 border border-accent/30 flex items-center justify-center shrink-0">
            <Keyboard size={18} className="text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-text-1 leading-tight">Keyboard shortcuts</h3>
            <p className="text-[12.5px] text-text-3 mt-1 leading-relaxed">
              Jump anywhere without the mouse. Press <Kbd>?</Kbd> any time to reopen this.
            </p>
          </div>
        </div>

        <div className="px-5 pb-2">
          {shortcutGroups().map(group => (
            <div key={group.heading} className="py-2">
              <div className="text-micro text-text-4 uppercase mb-1.5">{group.heading}</div>
              <div className="flex flex-col">
                {group.rows.map(row => (
                  <div key={row.label} className="flex items-center justify-between gap-4 py-1.5">
                    <span className="text-label text-text-2 min-w-0 truncate">{row.label}</span>
                    <KeyHint row={row} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 bg-bg-chrome border-t border-border-default">
          <p className="text-micro text-text-4">
            <Kbd>Esc</Kbd> <span className="ml-1.5">to close</span>
          </p>
        </div>
      </div>
    </div>
  )
}

// A single key chip, matching the ⌘K palette's ESC hint styling.
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="text-[10px] text-text-4 bg-bg-elevated border border-border-default rounded px-1.5 py-0.5">
      {children}
    </kbd>
  )
}

// Renders a row's key hint: chips joined by a faint "then" (sequential chord)
// or "+" (modifier combo), or a lone chip for single keys.
function KeyHint({ row }: { row: ShortcutRow }) {
  const sep = row.combo === 'plus' ? '+' : 'then'
  return (
    <span className="flex items-center gap-1 shrink-0">
      {row.keys.map((key, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-micro text-text-4">{sep}</span>}
          <Kbd>{key}</Kbd>
        </Fragment>
      ))}
    </span>
  )
}
