'use client'

import { useEffect, useRef } from 'react'
import { ArrowUp } from 'lucide-react'

interface ChatComposerProps {
  value: string
  /** True while a reply is generating — one live generation at a time. */
  disabled: boolean
  onChange(value: string): void
  onSend(): void
}

const MAX_HEIGHT_PX = 180

export function ChatComposer({ value, disabled, onChange, onSend }: ChatComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow with the draft up to a ceiling, then scroll inside the box.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [value])

  return (
    <div className="shrink-0 px-6 pb-6 pt-2">
      <div className="mx-auto w-full max-w-[720px]">
        <div className="flex items-end gap-2 p-2 rounded-md bg-bg-base border border-border-strong focus-within:border-accent transition-colors duration-200 ease-quart">
          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onSend()
              }
            }}
            placeholder={disabled ? 'Working on the last message…' : 'Ask about your search…'}
            aria-label="Message"
            className="flex-1 resize-none bg-transparent px-1.5 py-1 text-body text-text-2 placeholder:text-text-4 outline-none disabled:text-text-4 selectable"
          />
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !value.trim()}
            aria-label="Send message"
            className="shrink-0 w-8 h-8 rounded-pill bg-accent text-white flex items-center justify-center shadow-pill hover:bg-accent-hover active:scale-95 disabled:bg-border-default disabled:text-text-4 disabled:shadow-none disabled:cursor-not-allowed transition-[background-color,transform,box-shadow] duration-200 ease-quart"
          >
            <ArrowUp size={15} aria-hidden />
          </button>
        </div>
        <p className="mt-1.5 text-label text-text-4">
          Enter to send · Shift+Enter for a new line. Chat never sends anything on your behalf.
        </p>
      </div>
    </div>
  )
}
