import { useNavStore } from '@/store/nav'
// clsx, not cn(): twMerge reads the custom `text-body` size as a colour and
// would drop a caller's size class next to `text-text-1`.
import { clsx } from 'clsx'
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
      className={clsx(
        'inline-flex items-center gap-2 min-w-0 rounded duration-150',
        showName
          ? 'font-medium text-text-1 hover:text-accent-text hover:underline underline-offset-2 transition-colors'
          : 'hover:opacity-80 transition-opacity',
        className,
      )}
      title={`View ${company} details`}
    >
      <CompanyLogo company={company} size={size} className="shrink-0" />
      {showName && <span className="truncate">{company}</span>}
    </button>
  )
}
