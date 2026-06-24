import { useNavStore } from '@/store/nav'
import { CompanyLogo } from './CompanyLogo'

export function toCompanySlug(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

interface CompanyLinkProps {
  company: string
  size?: number
  className?: string
  showName?: boolean
}

export function CompanyLink({ company, size = 20, className = '', showName = false }: CompanyLinkProps) {
  // A plain <button> that drives the in-app nav store rather than a Next.js
  // <Link>. Under static export the AppShell decides what to render from
  // useNavStore.view, so a real route navigation would full-reload and reset
  // nav state back to the default tab. navigate('company', …) keeps us inside
  // the shell and opens the dossier in place.
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        useNavStore.getState().navigate('company', '', toCompanySlug(company))
      }}
      className={`inline-flex items-center gap-2 hover:opacity-80 transition-opacity ${showName ? 'font-medium text-text-1 hover:underline' : ''} ${className}`}
      title={`View ${company} details`}
    >
      <CompanyLogo company={company} size={size} className="shrink-0" />
      {showName && <span className="truncate">{company}</span>}
    </button>
  )
}
