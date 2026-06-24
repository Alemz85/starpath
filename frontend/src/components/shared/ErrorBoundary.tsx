'use client'

import { Component, type ReactNode } from 'react'
import { AlertTriangle, RotateCw, RefreshCw } from 'lucide-react'

interface Props {
  children: ReactNode
  /** Human label of the guarded view — shown in the fallback copy so the
   *  user knows *which* surface broke ("The Database view ran into an error"). */
  label?: string
}

interface State {
  error: Error | null
}

// Renderer crash guard. A throw during render anywhere in a view's subtree
// would otherwise blank the entire window — React unmounts the whole tree on
// an uncaught render error. This catches it, keeps the sidebar (which lives
// OUTSIDE the boundary) alive so the user can always navigate away, and offers
// in-place recovery. Mounted with key={view} in AppShell, so simply switching
// tabs remounts a fresh boundary and clears the error.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // Surface to the devtools console — the only place the stack is visible
    // since we swallow the throw for the user.
    console.error('[ErrorBoundary] view crashed:', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const where = this.props.label ? `The ${this.props.label} view` : 'This view'
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-8">
        <div className="w-[440px] max-w-full rounded-xl border border-border-default bg-bg-panel shadow-card overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-start gap-3">
              <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-full bg-danger/10">
                <AlertTriangle size={17} className="text-danger" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold text-text-1 leading-tight">{where} ran into an error</h2>
                <p className="text-[12.5px] text-text-3 mt-1.5 leading-relaxed">
                  The rest of starpath is fine and your data on disk is untouched. Try the view
                  again, or reload the app if it keeps happening.
                </p>
              </div>
            </div>
            {error.message && (
              <pre className="mt-4 max-h-32 overflow-auto rounded-md bg-bg-elevated border border-border-default px-3 py-2 text-[11px] font-mono text-text-2 whitespace-pre-wrap break-words">
                {error.message}
              </pre>
            )}
          </div>
          <div className="px-6 py-3.5 flex items-center justify-end gap-2 bg-bg-chrome border-t border-border-default">
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-label text-text-2 rounded-md hover:bg-bg-elevated transition-colors"
            >
              <RefreshCw size={12} />
              Reload app
            </button>
            <button
              onClick={this.reset}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-label text-white bg-accent hover:bg-accent-hover rounded-md font-medium transition-colors"
            >
              <RotateCw size={12} />
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }
}
