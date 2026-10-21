// App-wide commands that have more than one entry point: the native menu bar
// (electron/main.ts buildMenu), the ⌘K palette and the title-bar buttons.
// The menu reaches the renderer as one `menu:command` id (MenuCommands.tsx),
// which navigates where it must and then raises the command here; the view
// that owns the action subscribes with onAppCommand and runs the same handler
// its own button uses. Nothing is reachable only through a shortcut.

export type AppCommand =
  | 'add-listing'
  | 'export'
  | 'search'
  | 'palette'
  | 'shortcuts'
  | 'scan:full'
  | 'scan:api'
  | 'scan:filtered'
  | 'filter-db'

const EVENT = 'starpath:command'

export function sendAppCommand(id: AppCommand): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<AppCommand>(EVENT, { detail: id }))
}

/** Subscribe to one command; returns the unsubscribe for a useEffect cleanup. */
export function onAppCommand(id: AppCommand, handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (e: Event) => { if ((e as CustomEvent<AppCommand>).detail === id) handler() }
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
