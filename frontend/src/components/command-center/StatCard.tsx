import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  label: string
  value: string
  icon: LucideIcon
  accent?: string
  small?: boolean
  loading?: boolean
}

export function StatCard({ label, value, icon: Icon, accent, small, loading }: StatCardProps) {
  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-micro text-text-4 uppercase">{label}</span>
        <Icon size={13} className="text-text-4" />
      </div>
      {loading ? (
        <div className="h-6 w-16 shimmer rounded" />
      ) : (
        <span className={cn(
          'font-mono font-medium',
          small ? 'text-label text-text-2' : 'text-section text-text-1',
          accent,
        )}>
          {value}
        </span>
      )}
    </div>
  )
}
