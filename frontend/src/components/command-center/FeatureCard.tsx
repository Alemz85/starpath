import type { LucideIcon } from 'lucide-react'
import { ArrowRight } from 'lucide-react'

interface FeatureCardProps {
  onClick: () => void
  icon: LucideIcon
  label: string
  description: string
}

export function FeatureCard({ onClick, icon: Icon, label, description }: FeatureCardProps) {
  return (
    <button
      onClick={onClick}
      className="group w-full text-left bg-bg-panel border border-border-default hover:border-border-strong rounded-lg p-4 flex flex-col gap-3 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div className="p-2 bg-bg-elevated rounded-md">
          <Icon size={15} className="text-accent" />
        </div>
        <ArrowRight
          size={13}
          className="text-text-4 group-hover:text-text-2 group-hover:translate-x-0.5 transition-all"
        />
      </div>
      <div>
        <div className="text-body text-text-1 font-medium mb-0.5">{label}</div>
        <div className="text-label text-text-3 leading-snug">{description}</div>
      </div>
    </button>
  )
}
