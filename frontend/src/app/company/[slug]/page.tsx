import { CompanyView } from '@/components/company/CompanyView'

export default function CompanyPage({ params }: { params: { slug: string } }) {
  return <CompanyView slug={params.slug} />
}
