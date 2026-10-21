import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  companyOverview, deadlinesWithin, findApplication, findReport, latestEvaluation, todayIso,
} from './cardData'
import type { ApplicationEntry, ScoreEntry } from '@/types'

function app(company: string, role: string, extra: Partial<ApplicationEntry> = {}): ApplicationEntry {
  return {
    num: 1, date: '2026-10-01', company, role, score: 'M8 E6', status: 'Applied', pdf: false,
    deadline: 'n/d', report: '', notes: '', entityId: '', cities: [], ...extra,
  }
}

function evaluation(company: string, role: string, date: string, match: number, ease: number): ScoreEntry {
  return {
    date, archetype: '', skills_match: null, experience_bar: null, competition: null, ease,
    growth_mobility: null, optionality_exit: null, brand_value: null, role_content: null,
    best_cities: null, salary_adj_city: null, work_life_balance: null, match,
    priority: Math.sqrt(match * ease), eligibility: 'green', eligibility_flags: '', verdict: 'solid',
    best_fit_roles: '', mode: 'scouting', company, role, tier: 'T2', source: '', location: 'Lyon, France',
    employment_type: '', duration: '', salary_raw: '', url: `https://example.com/${company}/${role}`,
  }
}

test('lookups match company and role like the trackers (case, spacing), never fuzzily', () => {
  const apps = [app('Nimbus Robotics', 'Data Analyst')]
  assert.equal(findApplication(apps, ' nimbus  robotics', 'data analyst')?.company, 'Nimbus Robotics')
  assert.equal(findApplication(apps, 'Nimbus', 'Data Analyst'), null)
  const reports = [{ path: 'reports/tier-2/Nimbus Robotics - Data Analyst.md', company: 'Nimbus Robotics', role: 'Data Analyst', tier: 'T2', url: '' }]
  assert.equal(findReport(reports, 'NIMBUS ROBOTICS', 'Data Analyst')?.path, reports[0].path)
})

test('latestEvaluation takes the newest score-history row', () => {
  const rows = [
    evaluation('Nimbus Robotics', 'Data Analyst', '2026-09-01', 6, 5),
    evaluation('Nimbus Robotics', 'Data Analyst', '2026-10-01', 8, 7),
    evaluation('Nimbus Robotics', 'Other', '2026-11-01', 9, 9),
  ]
  assert.equal(latestEvaluation(rows, 'nimbus robotics', 'data analyst')?.match, 8)
  assert.equal(latestEvaluation(rows, 'Nimbus Robotics', 'Missing'), null)
})

test('companyOverview joins evaluations and applications, applications first', () => {
  const history = [
    evaluation('Nimbus Robotics', 'Data Analyst', '2026-09-01', 7, 6),
    evaluation('Nimbus Robotics', 'Ops Analyst', '2026-09-02', 9, 8),
    evaluation('Other Co', 'Data Analyst', '2026-09-02', 9, 9),
  ]
  const apps = [app('Nimbus Robotics', 'Data Analyst', { status: 'Interview' })]
  const o = companyOverview(history, apps, 'nimbus robotics')!
  assert.equal(o.name, 'Nimbus Robotics')
  assert.deepEqual(o.rows.map(r => r.role), ['Data Analyst', 'Ops Analyst'])
  assert.equal(o.rows[0].application?.status, 'Interview')
  assert.equal(o.rows[0].match, 7)
  assert.deepEqual([o.evaluated, o.applied], [2, 1])
  assert.equal(companyOverview(history, apps, 'Nobody'), null)
})

test('deadlinesWithin keeps unsent applications due inside the window', () => {
  const now = new Date(2026, 9, 20)
  const apps = [
    app('A', 'R', { status: 'Evaluated', deadline: '2026-10-22' }),
    app('B', 'R', { status: 'Evaluated', deadline: '2026-11-30' }),
    app('C', 'R', { status: 'Applied', deadline: '2026-10-21' }),
  ]
  assert.deepEqual(deadlinesWithin(apps, 7, now).map(d => d.company), ['A'])
  assert.deepEqual(deadlinesWithin(apps, 90, now).map(d => d.company), ['A', 'B'])
})

test('todayIso is the local date', () => {
  assert.equal(todayIso(new Date(2026, 0, 5, 23, 30)), '2026-01-05')
})
