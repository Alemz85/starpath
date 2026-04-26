'use client'

import { useAppStore } from '@/store/app'
import { cn } from '@/lib/utils'
import { Map, Briefcase } from 'lucide-react'

export function ModeToggle() {
  const { currentMode, toggleMode } = useAppStore()

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-micro text-text-4 uppercase">Evaluation mode</span>
      <div className="flex items-center gap-1 p-1 bg-bg-base border border-border-default rounded-lg">
        <button
          onClick={() => currentMode !== 'scouting' && toggleMode()}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-label transition-all',
            currentMode === 'scouting'
              ? 'bg-accent text-white'
              : 'text-text-3 hover:text-text-2',
          )}
        >
          <Map size={12} />
          Scouting
        </button>
        <button
          onClick={() => currentMode !== 'job-seeking' && toggleMode()}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-label transition-all',
            currentMode === 'job-seeking'
              ? 'bg-accent text-white'
              : 'text-text-3 hover:text-text-2',
          )}
        >
          <Briefcase size={12} />
          Job-seeking
        </button>
      </div>
    </div>
  )
}
