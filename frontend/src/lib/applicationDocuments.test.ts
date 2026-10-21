import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeDocuments, documentsUnknown, parseDocumentsValue, parseReportDocuments, summarizeDocuments,
} from '@/lib/applicationDocuments'

const FULL = 'CV required · cover letter optional · transcript required · references not stated · language test not stated · 1 file, 1 MB max · from the posting'

test('parseDocumentsValue reads every item, the limits and the source', () => {
  const d = parseDocumentsValue(FULL)
  assert.deepEqual(d.items, { cv: 'required', cover_letter: 'optional', transcript: 'required', references: 'not_stated', language_test: 'not_stated' })
  assert.equal(d.maxFiles, 1)
  assert.equal(d.maxSize, '1 MB')
  assert.deepEqual(d.notes, [])
  assert.equal(d.source, 'posting')
  assert.equal(d.sourceDate, null)
})

test('a line that only says "not stated" knows nothing', () => {
  for (const v of ['not stated', 'Not stated.', '', '—', 'n/d']) {
    const d = parseDocumentsValue(v)
    assert.ok(documentsUnknown(d), v)
    assert.equal(d.source, null)
    assert.equal(summarizeDocuments(d), 'Not stated')
  }
})

test('fails closed: unnamed items and unknown states stay not stated, never not asked', () => {
  const d = parseDocumentsValue('transcript required · cover letter maybe · from the posting')
  assert.equal(d.items.transcript, 'required')
  assert.equal(d.items.cover_letter, 'not_stated')
  assert.equal(d.items.cv, 'not_stated')
  assert.deepEqual(d.notes, ['cover letter maybe'])
  assert.ok(!Object.values(d.items).includes('not_asked'))
})

test('the form source keeps its date; anything else is a note', () => {
  const d = parseDocumentsValue('CV required · cover letter required · transcript required · references not asked · language test not asked · all documents in one PDF · writing sample required · from the form 2026-10-21')
  assert.equal(d.items.references, 'not_asked')
  assert.deepEqual(d.notes, ['all documents in one PDF', 'writing sample required'])
  assert.equal(d.source, 'form')
  assert.equal(d.sourceDate, '2026-10-21')
})

test('tolerates synonyms, casing, a colon and split limits', () => {
  const d = parseDocumentsValue('Résumé: Required · Motivation letter Not Asked · Transcripts optional · 2 files · 2.5mb max')
  assert.equal(d.items.cv, 'required')
  assert.equal(d.items.cover_letter, 'not_asked')
  assert.equal(d.items.transcript, 'optional')
  assert.equal(d.maxFiles, 2)
  assert.equal(d.maxSize, '2.5 MB')
  // The first mention of an item wins.
  assert.equal(parseDocumentsValue('CV required · CV optional').items.cv, 'required')
})

test('parseReportDocuments reads the header line only, null when the report has none', () => {
  const head = (line: string) => `# Scouting: Nimbus Robotics — Data Analyst\n\n**Date:** 2026-10-20\n**URL:** https://example.com/j/1\n${line}\n\n## Eligibility\n**Documents:** CV optional\n`
  assert.equal(parseReportDocuments(head(`**Documents:** ${FULL}`))?.items.transcript, 'required')
  assert.equal(parseReportDocuments(head('')), null)
  assert.equal(parseReportDocuments(null), null)
  assert.ok(documentsUnknown(parseReportDocuments(head('**Documents:** not stated'))!))
})

test('summarizeDocuments groups by state and leaves not-stated items to the tooltip', () => {
  assert.equal(summarizeDocuments(parseDocumentsValue(FULL)), 'CV, transcript required · cover letter optional · 1 file, 1 MB max')
  assert.equal(
    summarizeDocuments(parseDocumentsValue('cover letter not asked · references required · all in one PDF · from the form 2026-10-21')),
    'References required · cover letter not asked · all in one PDF',
  )
})

test('describeDocuments lists every item and names the source', () => {
  const lines = describeDocuments(parseDocumentsValue(FULL)).split('\n')
  assert.deepEqual(lines.slice(0, 5), ['CV: required', 'Cover letter: optional', 'Transcript: required', 'References: not stated', 'Language test: not stated'])
  assert.equal(lines[5], 'Uploads: 1 file, 1 MB max')
  assert.match(lines.at(-1)!, /^From the posting/)
  assert.equal(describeDocuments(parseDocumentsValue('CV required · from the form 2026-10-21')).split('\n').at(-1), 'From the application form, 2026-10-21')
  assert.match(describeDocuments(parseDocumentsValue('not stated')).split('\n').at(-1)!, /^Source not stated/)
})
