'use client'

import { useDataStore } from '@/store/data'
import { toCompanySlug } from '@/components/shared/CompanyLink'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { OffersTable } from '@/components/database/OffersTable'
import { ReportSlideOver } from '@/components/reports/ReportSlideOver'
import { useState, useMemo } from 'react'
import type { ScoreEntry } from '@/types'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export function CompanyView({ slug }: { slug: string }) {
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const applications = useDataStore(s => s.applications)
  const loaded = useDataStore(s => s.loaded)
  const [selectedEntry, setSelectedEntry] = useState<ScoreEntry | null>(null)

  // Find the actual company name from the slug
  const companyName = useMemo(() => {
    return scoreHistory.find(s => toCompanySlug(s.company) === slug)?.company || 
           applications.find(a => toCompanySlug(a.company) === slug)?.company ||
           slug
  }, [slug, scoreHistory, applications])

  // Filter data for this company
  const history = useMemo(() => {
    return scoreHistory.filter(s => toCompanySlug(s.company) === slug)
  }, [slug, scoreHistory])

  const selectedId = selectedEntry ? `${selectedEntry.company}-${selectedEntry.role}` : null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome flex items-center">
        <Link 
          href="/" 
          className="p-1.5 hover:bg-bg-elevated rounded-md text-text-3 hover:text-text-1 transition-colors"
          title="Back to home"
        >
          <ArrowLeft size={16} />
        </Link>
        <CompanyLogo company={companyName} size={24} />
        <h1 className="text-body text-text-1 font-medium">{companyName}</h1>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-8 bg-bg-base">
        <section className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-h3 font-medium text-text-1">Score History & Roles</h2>
            <div className="text-label text-text-4">{history.length} evaluation{history.length !== 1 && 's'}</div>
          </div>
          {loaded ? (
            <div className="border border-border-default rounded-md overflow-hidden bg-bg-chrome">
              <OffersTable 
                rows={history} 
                onOpenReport={setSelectedEntry}
                onRowClick={(entry) => setSelectedEntry(entry)}
                selectedId={selectedId}
              />
            </div>
          ) : (
             <div className="py-12 flex items-center justify-center">
               <div className="text-label text-text-4">Loading…</div>
             </div>
          )}
        </section>
      </div>

      {selectedEntry && (
        <ReportSlideOver
          company={selectedEntry.company}
          role={selectedEntry.role}
          scoreEntry={selectedEntry}
          onSwitchEntity={(targetCompany, targetRole) => {
            const match = [...scoreHistory]
              .filter(r => r.company === targetCompany && r.role === targetRole)
              .sort((a, b) => b.date.localeCompare(a.date))[0]
            if (match) setSelectedEntry(match)
          }}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </div>
  )
}
