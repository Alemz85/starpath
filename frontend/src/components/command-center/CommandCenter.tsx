'use client'

import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { ModeToggle } from './ModeToggle'
import { StatCard } from './StatCard'
import { FeatureCard } from './FeatureCard'
import {
  Database, FileText, GitBranch, TrendingUp, Radar, Settings,
  BarChart2, Clock, Inbox, Target, AlertTriangle, Calendar,
} from 'lucide-react'
import { deadlineUrgency } from '@/lib/utils'

export function CommandCenter() {
  const { currentMode } = useAppStore()
  const { scoreHistory, scouting, applications, pipeline, loaded } = useDataStore()
  const { navigate } = useNavStore()

  // Compute stats
  const totalEvaluated = scoreHistory.length
  const active = applications.filter(a =>
    ['Applied', 'Responded', 'Interview', 'Offer'].includes(a.status)
  ).length
  const pendingUrls = pipeline.length
  const scoutingEntries = scouting.length

  const urgentDeadlines = [
    ...scouting.map(s => s.deadline),
    ...applications.map(a => a.deadline),
  ].filter(d => deadlineUrgency(d) === 'urgent').length

  const lastScanDate = scoreHistory.length
    ? scoreHistory.sort((a, b) => b.date.localeCompare(a.date))[0]?.date
    : null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="titlebar-drag h-11 border-b border-border-default shrink-0" />

      <div className="flex-1 overflow-y-auto p-8">
        {/* Hero */}
        <div className="mb-8">
          <div className="galaxy-bg rounded-lg p-6 border border-border-default">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-page text-text-1 mb-1">Command Center</h1>
                <p className="text-body text-text-3">
                  {loaded ? `${totalEvaluated} offers evaluated · ${scoutingEntries} scouting entries` : 'Loading data…'}
                </p>
              </div>
              <ModeToggle />
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3 mb-8 lg:grid-cols-6">
          <StatCard
            label="Total evaluated"
            value={loaded ? String(totalEvaluated) : '—'}
            icon={BarChart2}
            loading={!loaded}
          />
          <StatCard
            label="Active"
            value={loaded ? String(active) : '—'}
            icon={Target}
            accent="text-accent"
            loading={!loaded}
          />
          <StatCard
            label="Pending URLs"
            value={loaded ? String(pendingUrls) : '—'}
            icon={Inbox}
            loading={!loaded}
          />
          <StatCard
            label="Scouting"
            value={loaded ? String(scoutingEntries) : '—'}
            icon={GitBranch}
            loading={!loaded}
          />
          <StatCard
            label="Urgent deadlines"
            value={loaded ? String(urgentDeadlines) : '—'}
            icon={AlertTriangle}
            accent={urgentDeadlines > 0 ? 'text-danger' : undefined}
            loading={!loaded}
          />
          <StatCard
            label="Last scan"
            value={lastScanDate ?? '—'}
            icon={Calendar}
            small
            loading={!loaded}
          />
        </div>

        {/* Feature cards */}
        <div>
          <p className="text-micro text-text-4 uppercase mb-3">Features</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <FeatureCard
              onClick={() => navigate('database')}
              icon={Database}
              label="Database"
              description={`Browse all ${totalEvaluated} evaluated offers`}
            />
            <FeatureCard
              onClick={() => navigate('reports')}
              icon={FileText}
              label="Reports"
              description="Read full evaluation reports"
            />
            <FeatureCard
              onClick={() => navigate('pipeline')}
              icon={GitBranch}
              label="Pipeline"
              description={`${active} active · ${pendingUrls} pending URLs`}
            />
            <FeatureCard
              onClick={() => navigate('trends')}
              icon={TrendingUp}
              label="Trends"
              description="CF/AF over time by archetype"
            />
            <FeatureCard
              onClick={() => navigate('scan')}
              icon={Radar}
              label="Scan"
              description="Discover new offers from portals"
            />
            <FeatureCard
              onClick={() => navigate('settings')}
              icon={Settings}
              label="Settings"
              description="Profile, CV, portals, preferences"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
