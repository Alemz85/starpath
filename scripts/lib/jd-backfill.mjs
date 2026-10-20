// jd-backfill.mjs — the backfill decision for one report, with the network and
// the disk injected. scripts/archive-posting.mjs wires the real ones.

import { formatArchive } from './jd-archive-core.mjs'
import { fetchPosting, planFetch } from './jd-fetch-core.mjs'

/**
 * Archive one audited report row (see auditReports).
 *
 * Outcomes:
 *   archived      text fetched and written
 *   would-archive dry run: the route that would be used, nothing fetched/written
 *   exists        already archived; nothing to do
 *   gone          the posting is gone — logged as unrecoverable, nothing written
 *   unreachable   fetch failed for a transient reason — nothing written or logged
 *   unextractable reachable, but no posting text found — logged as unrecoverable
 *   no-url        the report has no listing URL — logged as unrecoverable
 *
 * @param {object} row  an audit row
 * @param {{ http: object, today: string, write: (name:string, content:string)=>void,
 *           logUnrecoverable: (entry:object)=>void, dryRun?: boolean, key: string }} deps
 */
export async function archiveRow(row, { http, today, write, logUnrecoverable, dryRun = false, key }) {
  if (row.status === 'archived') return { outcome: 'exists', file: row.file }
  const fail = (outcome, reason) => {
    if (!dryRun) logUnrecoverable({ date: today, key, url: row.url, reason })
    return { outcome, reason }
  }
  if (!row.url) return fail('no-url', 'the report has no listing URL')
  const plan = planFetch(row.url)
  if (!plan) return fail('no-url', 'the report URL is not an http(s) URL')
  if (dryRun) return { outcome: 'would-archive', via: plan.kind, source: plan.source, url: plan.apiUrl ?? plan.pageUrl, file: row.expected }

  const got = await fetchPosting(row.url, http)
  if (got.status === 'ok') {
    write(row.expected, formatArchive({
      company: row.company, role: row.role, url: row.url, fetched: today, source: got.source, body: got.text,
    }))
    return { outcome: 'archived', file: row.expected, source: got.source }
  }
  if (got.status === 'unreachable') return { outcome: 'unreachable', reason: got.reason }
  return fail(got.status === 'gone' ? 'gone' : 'unextractable', got.reason)
}
