'use client'

import { useEffect, useRef } from 'react'
import { ArrowUp } from 'lucide-react'
import { Button } from '@/components/ui'

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
        <div className="card rounded-lg flex items-end gap-2 p-2 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20 transition-colors duration-150 ease-quart">
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
            className="flex-1 resize-none border-0 bg-transparent px-1.5 py-1 text-body text-text-1 placeholder:text-text-4 outline-none disabled:text-text-4 selectable"
          />
          <Button
            tone="primary"
            size="sm"
            iconOnly
            icon={<ArrowUp size={14} aria-hidden />}
            onClick={onSend}
            disabled={disabled || !value.trim()}
            aria-label="Send message"
            className="shrink-0"
          />
        </div>
        <p className="mt-1.5 text-label text-text-4">
          Enter to send · Shift+Enter for a new line. Chat never sends anything on your behalf.
        </p>
      </div>
    </div>
  )
}
