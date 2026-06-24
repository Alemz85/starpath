import Link from 'next/link'
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
  const slug = toCompanySlug(company)
  return (
    <Link 
      href={`/company?slug=${slug}`} 
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-2 hover:opacity-80 transition-opacity ${showName ? 'font-medium text-text-1 hover:underline' : ''} ${className}`}
      title={`View ${company} details`}
    >
      <CompanyLogo company={company} size={size} className="shrink-0" />
      {showName && <span className="truncate">{company}</span>}
    </Link>
  )
}
