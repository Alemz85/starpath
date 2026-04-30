#!/usr/bin/env node

/**
 * probe-ats.mjs — Probe public ATS APIs for a list of companies.
 *
 * Tries each of: Greenhouse, Ashby, Lever, SmartRecruiters with name-derived
 * slug variants. Reports HTTP-200 hits so we can add them to portals.yml as
 * proper API-based tracked_companies (zero token cost) instead of falling
 * back to websearch.
 *
 * Usage:
 *   node scripts/probe-ats.mjs <company1> "<company2 with spaces>" ...
 *   echo -e "ABB\nABInBev\nAdani" | node scripts/probe-ats.mjs --stdin
 *
 * Output: TSV to stdout — `company\tats\tapi_url\tcareers_url`
 *         or `company\t-\t-\t-` for misses (so the diff is auditable).
 *
 * No LLM tokens; pure HTTP HEAD/GET probes.
 */

import { argv, exit } from 'process'

const PROBES = [
  {
    name: 'greenhouse',
    api: slug => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?per_page=1`,
    careers: slug => `https://job-boards.greenhouse.io/${slug}`,
  },
  {
    name: 'ashby',
    api: slug => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`,
    careers: slug => `https://jobs.ashbyhq.com/${slug}`,
  },
  {
    name: 'lever',
    api: slug => `https://api.lever.co/v0/postings/${slug}?limit=1`,
    careers: slug => `https://jobs.lever.co/${slug}`,
  },
  {
    name: 'smartrecruiters',
    api: slug => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`,
    careers: slug => `https://careers.smartrecruiters.com/${slug}`,
  },
]

// Generate slug candidates from a company name. Order = priority.
function slugCandidates(name) {
  const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const lc = base.toLowerCase()
  const variants = new Set([
    lc.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),     // "boston-consulting-group"
    lc.replace(/[^a-z0-9]+/g, ''),                            // "bostonconsultinggroup"
    lc.replace(/\s+&\s+/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    lc.replace(/\s+/g, '_').replace(/[^a-z0-9_]+/g, ''),      // "boston_consulting_group"
    lc.split(/[\s\-,]/)[0],                                    // first word, e.g. "boston"
  ])
  variants.delete('')
  return [...variants]
}

async function probeOne(company) {
  const slugs = slugCandidates(company)
  for (const probe of PROBES) {
    for (const slug of slugs) {
      try {
        const res = await fetch(probe.api(slug), {
          method: 'GET',
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': 'starpath-ats-probe/1.0' },
        })
        if (!res.ok) continue
        // Many ATSes return 200 with empty/zero payloads for nonexistent
        // slugs. Require evidence of an ACTUAL company tenant — a real
        // posting in the response, OR a totalFound/totalCount > 0.
        // (If a real tenant has zero current openings, the probe will miss
        //  it; that's acceptable — nothing to scan anyway.)
        const text = await res.text()
        if (!text || text.length < 20) continue
        let looksValid = false
        try {
          if (probe.name === 'greenhouse') {
            // 404 → not a tenant. 200 with `meta.total > 0` or jobs.length > 0 → tenant.
            const j = JSON.parse(text)
            looksValid = (j?.meta?.total > 0) || (Array.isArray(j?.jobs) && j.jobs.length > 0)
          } else if (probe.name === 'ashby') {
            const j = JSON.parse(text)
            looksValid = Array.isArray(j?.jobs) && j.jobs.length > 0
          } else if (probe.name === 'lever') {
            // Lever returns [] for nonexistent slugs (200) — same problem.
            // Require at least one posting object.
            const j = JSON.parse(text)
            looksValid = Array.isArray(j) && j.length > 0
          } else if (probe.name === 'smartrecruiters') {
            const j = JSON.parse(text)
            looksValid = j?.totalFound > 0 || (Array.isArray(j?.content) && j.content.length > 0)
          }
        } catch {
          looksValid = false
        }
        if (!looksValid) continue
        return {
          ats:         probe.name,
          slug,
          api:         probe.api(slug),
          careers_url: probe.careers(slug),
        }
      } catch {
        // network / timeout — continue to next slug
      }
    }
  }
  return null
}

async function main() {
  let companies = []
  if (argv.includes('--stdin')) {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    companies = Buffer.concat(chunks).toString('utf8').split('\n').map(s => s.trim()).filter(Boolean)
  } else {
    companies = argv.slice(2).filter(s => !s.startsWith('--'))
  }
  if (companies.length === 0) {
    process.stderr.write('probe-ats: no companies provided. Pass as args or pipe via --stdin.\n')
    exit(1)
  }
  process.stdout.write('company\tats\tslug\tapi\tcareers_url\n')
  for (const company of companies) {
    const hit = await probeOne(company)
    if (hit) {
      process.stdout.write(`${company}\t${hit.ats}\t${hit.slug}\t${hit.api}\t${hit.careers_url}\n`)
    } else {
      process.stdout.write(`${company}\t-\t-\t-\t-\n`)
    }
  }
}

main().catch(err => {
  process.stderr.write(`probe-ats: ${err.stack ?? err.message ?? err}\n`)
  exit(2)
})
