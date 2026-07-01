// warm-outreach-core.mjs — pure sweep for "where does a warm path exist RIGHT NOW?"
//
// THE PROBLEM THIS SOLVES
// scripts/outreach-plan.mjs answers "what's my best outreach move at {company}?"
// for ONE company the user already named. The daily brief answers "what should I
// do now?" across the WHOLE pipeline — but it only knew about outreach threads
// already opened (outreach-core nudges). The single highest-ROI move in a job
// search — an *untouched* warm referral path into a pipeline company — was
// invisible until the user thought to ask about that company by name.
//
// This module runs the same per-company decision the outreach-plan dossier uses
// (network paths × thread state → recommendPlay) across every pipeline company
// with a mapped contact, and keeps only the opportunities where the recommended
// play is a warm first touch:
//
//   warm-direct  an untouched 1st-degree contact → message them directly
//   warm-intro   an untouched 2nd-degree contact → ask the bridge for an intro
//
// Everything else recommendPlay can return is deliberately EXCLUDED here,
// mirroring the outreach-plan cautions:
//   • nudge          → already surfaced by the brief's "Outreach nudges due"
//                      section (outreach-core); listing it twice is noise.
//   • reply-handoff  → a live conversation, not a brief to-do.
//   • wait           → an on-track thread; another touch would pester.
//   • cold-search    → no warm asset exists; nothing to surface.
// Additionally, a company with ANY live/pending thread (`waiting`) is skipped
// entirely — the brief must never suggest a parallel first touch while a thread
// is in flight, even though the full dossier would surface it with a caution
// (the dossier has room to say "coordinate the asks"; a one-line brief doesn't).
// Exhausted (cold) contacts are never suggested: recommendPlay never targets
// them, and their paths read as touched, so they can't be the "untouched" pick.
//
// Ranking: highest-value first — by the best pipeline role score at the company
// (a referral matters most where the fit is best), then by the target contact's
// warmth, then company name for a stable order.
//
// Pure: no filesystem, no clock, no network. The composition layer
// (scripts/daily-brief.mjs) parses data/network.md + the pipeline files +
// data/outreach.md with the existing cores and passes the parsed facts in.
// This module re-implements NO math — it composes network-core's matcher with
// outreach-plan-core's decision ladder. No user data ships here.

import { matchNetworkToPipeline } from './network-core.mjs';
import { companyThreads, annotatePaths, recommendPlay } from './outreach-plan-core.mjs';

/**
 * Sweep the pipeline × network for warm first-touch opportunities.
 *
 * @param {object} input
 *   - contacts           {Array}  parsed network roster (network-core parseNetwork)
 *   - pipeline           {Array}  parsed pipeline targets (network-core parsePipeline)
 *   - collapsedContacts  {Array}  collapsed outreach log (outreach-cadence collapse(parseLog(...)))
 *   - today              {string} YYYY-MM-DD (recency + cadence classification)
 * @returns {Array} opportunities, highest-value first:
 *   { company, play, target, topRole, reason, channel, cautions, counts }
 *   where play ∈ {'warm-direct','warm-intro'}, target is recommendPlay's target
 *   ({ name, title, leverage, warmth, degree, via }), topRole is the company's
 *   best pipeline role ({ role, score, source }) or null, and counts is
 *   { paths, untouched }.
 */
export function warmOutreachOpportunities({
  contacts = [],
  pipeline = [],
  collapsedContacts = [],
  today = null,
} = {}) {
  if (!Array.isArray(contacts) || !contacts.length) return [];
  if (!Array.isArray(pipeline) || !pipeline.length) return [];

  const { matches } = matchNetworkToPipeline(contacts, pipeline, today);
  const out = [];

  for (const m of matches) {
    const threads = companyThreads(collapsedContacts, m.company, today);

    // A live/pending thread at this company → no parallel first touch, period.
    if (threads.some((t) => t.action === 'waiting')) continue;

    const annotated = annotatePaths(m.contacts, threads);
    const rec = recommendPlay({ paths: annotated, threads });
    if (rec.play !== 'warm-direct' && rec.play !== 'warm-intro') continue;

    out.push({
      company: m.company,
      play: rec.play,
      target: rec.target,
      topRole: m.roles[0] || null, // matchNetworkToPipeline sorts roles score-desc
      reason: rec.reason,
      channel: rec.channel,
      cautions: rec.cautions || [],
      counts: {
        paths: annotated.length,
        untouched: annotated.filter((p) => !p.thread).length,
      },
    });
  }

  out.sort(
    (a, b) =>
      (b.topRole?.score ?? 0) - (a.topRole?.score ?? 0) ||
      (b.target?.warmth ?? 0) - (a.target?.warmth ?? 0) ||
      String(a.company).localeCompare(String(b.company)),
  );
  return out;
}
