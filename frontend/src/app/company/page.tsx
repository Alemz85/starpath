'use client'

import { useSearchParams } from 'next/navigation'
import { CompanyView } from '@/components/company/CompanyView'
import { Suspense } from 'react'

function CompanyPageContent() {
  const params = useSearchParams()
  const slug = params.get('slug')
  if (!slug) return null
  return <CompanyView slug={slug} />
}

export default function CompanyPage() {
  return (
    <Suspense fallback={<div className="p-6 text-label text-text-4">Loading...</div>}>
      <CompanyPageContent />
    </Suspense>
  )
}
