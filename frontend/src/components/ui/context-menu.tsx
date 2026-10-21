'use client'

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ElementType, type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

// Secondary-click (contextual) menu: the same actions a row or card already
// shows as buttons or in its popover, reachable with a right-click or a
// Control-click on the row itself. Items that don't apply to the row are left
// out, not dimmed (`false`/`null` entries are dropped), so the menu is never a
// list of greyed-out options; `disabled` is for an action that exists but is
// blocked right now (demo mode's read-only gate), with the reason in `title`.
// Destructive items go last with `tone: 'danger'`. No shortcut hints: a
// context menu lists actions, the main interface teaches the keys.

export interface ContextMenuAction {
  label: string
  /** Lucide icon component; rendered at 14px. */
  icon?: ElementType
  onSelect: () => void
  tone?: 'default' | 'danger'
  disabled?: boolean
  /** Tooltip, mostly the reason a disabled item is disabled. */
  title?: string
}

export type ContextMenuItem = ContextMenuAction | 'separator'

/** What callers may pass: items, or conditionals that resolve to nothing. */
export type ContextMenuItemInput = ContextMenuItem | false | null | undefined

/** The subset of a pointer event the menu needs, so a React click, a React
 *  contextmenu and a native event all qualify. */
export interface MenuAnchorEvent {
  clientX: number
  clientY: number
  preventDefault: () => void
  stopPropagation: () => void
}

export interface ContextMenuProps {
  items: ContextMenuItemInput[]
  anchor: { x: number; y: number }
  onClose: () => void
}

const MENU_WIDTH = 220
const EDGE = 8

/** True for a right-click or a Control-click (macOS's secondary click). */
export function isSecondaryClick(e: { button?: number; ctrlKey?: boolean }): boolean {
  return e.button === 2 || (!!e.ctrlKey && (e.button ?? 0) === 0)
}

/** Drop conditionals, then collapse separators so none leads, trails or doubles. */
export function normalizeItems(items: ContextMenuItemInput[]): ContextMenuItem[] {
  const out: ContextMenuItem[] = []
  for (const it of items) {
    if (!it) continue
    if (it === 'separator') {
      if (out.length === 0 || out[out.length - 1] === 'separator') continue
      out.push(it)
    } else {
      out.push(it)
    }
  }
  while (out.length && out[out.length - 1] === 'separator') out.pop()
  return out
}

/**
 * The menu itself, in a portal at the pointer position, clamped inside the
 * window. Closes on Escape, outside press, blur, resize and after a selection.
 * Arrow keys move between items, Enter/Space select, Home/End jump.
 */
export function ContextMenu({ items, anchor, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const list = useMemo(() => normalizeItems(items), [items])
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y })
  const restoreFocus = useRef<Element | null>(null)

  // Measure once mounted and keep the menu on screen: flip above the pointer
  // when it would run off the bottom, nudge left off the right edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = anchor.x
    let top = anchor.y
    if (left + width + EDGE > vw) left = Math.max(EDGE, vw - width - EDGE)
    if (top + height + EDGE > vh) top = Math.max(EDGE, anchor.y - height)
    setPos({ left, top })
  }, [anchor.x, anchor.y, list.length])

  // Focus the menu so arrow keys work at once; put focus back where it was
  // when the menu goes away.
  useEffect(() => {
    restoreFocus.current = document.activeElement
    ref.current?.focus({ preventScroll: true })
    return () => {
      const prev = restoreFocus.current
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    const onAway = () => onClose()
    // Defer the press listener a tick so the press that opened the menu
    // (a Control-click's own click) doesn't close it straight away.
    const t = window.setTimeout(() => document.addEventListener('pointerdown', onDocPointerDown, true), 0)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onAway)
    window.addEventListener('resize', onAway)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onAway)
      window.removeEventListener('resize', onAway)
    }
  }, [onClose])

  const focusableItems = () =>
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = focusableItems()
    if (buttons.length === 0) return
    const idx = buttons.findIndex(b => b === document.activeElement)
    const go = (i: number) => { e.preventDefault(); buttons[(i + buttons.length) % buttons.length]?.focus() }
    switch (e.key) {
      case 'ArrowDown': go(idx + 1); break
      case 'ArrowUp':   go(idx < 0 ? buttons.length - 1 : idx - 1); break
      case 'Home':      go(0); break
      case 'End':       go(buttons.length - 1); break
      case 'Tab':       e.preventDefault(); onClose(); break
      default: break
    }
  }

  if (typeof document === 'undefined' || list.length === 0) return null

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // Portal events still bubble through the React tree: keep a right-click
      // on the menu from reopening it through the row that owns it.
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
      onClick={(e) => e.stopPropagation()}
      className="titlebar-no-drag fixed z-50 p-1 rounded-xl border border-border-default bg-bg-base shadow-menu outline-none"
      style={{ left: pos.left, top: pos.top, minWidth: MENU_WIDTH, maxWidth: 300, animation: 'chip-appear 160ms ease both' }}
    >
      {list.map((item, i) => (
        item === 'separator'
          ? <div key={`sep-${i}`} role="separator" className="my-1 mx-1 border-t border-border-default" />
          : <MenuItem key={`${item.label}-${i}`} item={item} onClose={onClose} />
      ))}
    </div>,
    document.body,
  )
}

function MenuItem({ item, onClose }: { item: ContextMenuAction; onClose: () => void }) {
  const { label, icon: Icon, onSelect, tone = 'default', disabled, title } = item
  const danger = tone === 'danger'
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        if (disabled) return
        onClose()
        onSelect()
      }}
      className={cn(
        'group w-full h-8 flex items-center gap-2.5 px-2 rounded text-body text-left transition-colors duration-150',
        'outline-none',
        disabled
          ? 'text-text-4 cursor-not-allowed'
          : danger
            ? 'text-danger hover:bg-danger/5 focus-visible:bg-danger/5'
            : 'text-text-2 hover:bg-bg-elevated hover:text-text-1 focus-visible:bg-bg-elevated focus-visible:text-text-1',
      )}
    >
      {Icon && (
        <Icon
          size={14}
          className={cn('shrink-0', disabled ? 'text-text-4' : danger ? 'text-current' : 'text-text-3 group-hover:text-text-2')}
          aria-hidden
        />
      )}
      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * State for one context menu. `open(event, items)` swallows the event and
 * shows the menu at the pointer; put `element` anywhere in the tree (it
 * portals to the body). Pass `open` to both `onContextMenu` and, guarded by
 * `isSecondaryClick`, `onClick`, so a Control-click opens it too.
 *
 *   const menu = useContextMenu()
 *   <tr onContextMenu={(e) => menu.open(e, items)} …>{…}</tr>
 *   {menu.element}
 */
export function useContextMenu(): {
  open: (event: MenuAnchorEvent, items: ContextMenuItemInput[]) => void
  close: () => void
  isOpen: boolean
  element: ReactNode
} {
  const [state, setState] = useState<{ anchor: { x: number; y: number }; items: ContextMenuItemInput[] } | null>(null)

  const open = useCallback((event: MenuAnchorEvent, items: ContextMenuItemInput[]) => {
    event.preventDefault()
    event.stopPropagation()
    if (normalizeItems(items).length === 0) return
    setState({ anchor: { x: event.clientX, y: event.clientY }, items })
  }, [])
  const close = useCallback(() => setState(null), [])

  const element = state
    ? <ContextMenu items={state.items} anchor={state.anchor} onClose={close} />
    : null

  return { open, close, isOpen: state != null, element }
}

/** Opens the menu on a Control-click; returns true when it did, so the
 *  caller skips its normal click action. */
export function openOnControlClick(
  e: ReactMouseEvent,
  open: (event: MenuAnchorEvent, items: ContextMenuItemInput[]) => void,
  items: ContextMenuItemInput[],
): boolean {
  if (!isSecondaryClick(e)) return false
  open(e, items)
  return true
}
