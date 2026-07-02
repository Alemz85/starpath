/**
 * network-lens-core.mjs — pure composition for the frontend's Network lens.
 *
 * THE PROBLEM THIS SOLVES
 * The warm-outreach stack (network-core roster×pipeline matcher, outreach-core
 * cadence, outreach-plan-core decision ladder, warm-outreach-core sweep) had no
 * single "whole picture" artifact: each core answers one question, and the CLIs
 * stitch them per-surface (network.mjs, outreach-plan.mjs, daily-brief.mjs).
 * The desktop app's Network tab needs all four answers at once —
 *
 *   1. who's in the roster (data/network.md),
 *   2. which pipeline companies have a warm path in, and what the recommended
 *      play there is (the outreach-plan decision ladder, per company),
 *   3. cadence state on every open outreach thread (due nudge / waiting /
 *      cold / replied),
 *   4. coverage gaps — pipeline companies with NO mapped contact, ranked by
 *      how much a referral would matter there (best role score first).
 *
 * This module composes the existing cores into that one JSON-safe overview.
 * It re-implements NO parsing and NO ranking math — every verdict comes from
 * the same functions the CLIs and the daily brief use, so the app, the brief,
 * and `npm run network` always agree.
 *
 * Pure: no filesystem, no clock, no network. The caller (the Electron main
 * process via IPC, or a test) reads the files and injects `today`; passing
 * `null`/missing content for any file degrades to "that layer is empty", never
 * a throw — a malformed on-disk table only drops its malformed rows (the
 * underlying parsers already skip anything that isn't a valid data row).
 *
 * No user data ships here: everything is derived from the caller's inputs.
 */

import { parseNetwork, parsePipeline, matchNetworkToPipeline } from './network-core.mjs';
import { companyThreads, annotatePaths, recommendPlay } from './outreach-plan-core.mjs';
import { parseLog, collapse } from '../outreach-cadence.mjs';
import { classifyAll } from '../outreach-core.mjs';

/* Companies are ordered by how actionable their recommended play is — the
 * decision ladder's own priority (a live reply beats a due nudge beats an
 * untouched warm path…), then by the best role score at the company, then by
 * name for a stable order. */
const PLAY_RANK = {
  'reply-handoff': 0,
  nudge: 1,
  'warm-direct': 2,
  'warm-intro': 3,
  wait: 4,
  'cold-search': 5,
};

/** Slim an annotated referral path down to the JSON the lens renders. */
function slimPath(p) {
  return {
    name: p.name,
    title: p.title || '',
    relationship: p.relationship,
    degree: p.degree,
    via: p.via || '',
    lastContact: p.lastContact || '',
    warmth: p.warmth ?? 0,
    leverage: p.leverage || 'neutral',
    thread: p.thread
      ? { action: p.thread.action, touches: p.thread.touches ?? null, lastTouch: p.thread.lastTouch ?? null }
      : null,
  };
}

/** Slim a classified outreach thread down to what the cadence strip shows. */
function slimThread(t) {
  return {
    company: t.company,
    contact: t.contact,
    role: t.role || '',
    title: t.title || '',
    channel: t.channel || '',
    action: t.action,
    state: t.state,
    leverage: t.leverage || 'neutral',
    daysSince: t.daysSince ?? null,
    nextNudge: t.nextNudge ?? null,
    touches: t.touches ?? null,
    lastTouch: t.lastTouch || '',
    reason: t.reason || '',
  };
}

/** Slim an orphan contact (known person at a non-pipeline company). */
function slimLead(c) {
  return {
    name: c.name,
    company: c.company,
    companyKey: c.companyKey,
    title: c.title || '',
    relationship: c.relationship,
    degree: c.degree,
    via: c.via || '',
    lastContact: c.lastContact || '',
    warmth: c.warmth ?? 0,
    notes: c.notes || '',
  };
}

/**
 * Build the whole-network overview for the frontend lens.
 *
 * @param {object} input
 *   - networkRaw       {string|null} data/network.md content (null = missing)
 *   - applicationsRaw  {string|null} data/applications.md content
 *   - scoutingRaw      {string|null} data/scouting.md content
 *   - outreachRaw      {string|null} data/outreach.md content
 *   - today            {string}      YYYY-MM-DD — REQUIRED for honest cadence
 *                      verdicts (a null today makes every dated thread read as
 *                      "no valid date"); injected so this stays clock-free.
 * @returns {object} JSON-safe overview:
 *   { today, roster, companies, gaps, latentLeads, threads, counts }
 */
export function buildNetworkOverview({
  networkRaw = null,
  applicationsRaw = null,
  scoutingRaw = null,
  outreachRaw = null,
  today = null,
} = {}) {
  const contacts = parseNetwork(networkRaw ?? '');
  const pipeline = parsePipeline(applicationsRaw ?? '', scoutingRaw ?? '');
  const collapsed = collapse(parseLog(outreachRaw ?? ''));

  const { matches, gaps, orphanContacts } = matchNetworkToPipeline(contacts, pipeline, today);

  // Per pipeline company with ≥1 mapped contact: annotate the paths with any
  // existing thread state and run the decision ladder — exactly what the
  // outreach-plan dossier does, minus the draft ingredients.
  const companies = matches.map((m) => {
    const threads = companyThreads(collapsed, m.company, today);
    const annotated = annotatePaths(m.contacts, threads);
    const rec = recommendPlay({ paths: annotated, threads });
    return {
      company: m.company,
      companyKey: m.companyKey,
      topRole: m.roles[0] ?? null, // matcher sorts roles score-desc
      roles: m.roles,
      play: rec.play,
      target: rec.target,
      reason: rec.reason,
      channel: rec.channel ?? null,
      cautions: rec.cautions ?? [],
      paths: annotated.map(slimPath),
      counts: {
        paths: annotated.length,
        untouched: annotated.filter((p) => !p.thread).length,
      },
    };
  });
  companies.sort(
    (a, b) =>
      (PLAY_RANK[a.play] ?? 9) - (PLAY_RANK[b.play] ?? 9) ||
      (b.topRole?.score ?? 0) - (a.topRole?.score ?? 0) ||
      String(a.company).localeCompare(String(b.company)),
  );

  // Every open thread, cadence-classified and sorted most-actionable-first
  // (classifyAll: nudge > waiting > cold > done, then leverage priority).
  const { entries, counts: threadCounts } = classifyAll(collapsed, today);
  const threads = entries.map(slimThread);

  return {
    today,
    roster: contacts, // parseNetwork's shape: num/name/company/companyKey/title/relationship/degree/via/lastContact/notes
    companies,
    gaps, // matcher's shape, already topScore-desc: { company, companyKey, topScore, roles }
    latentLeads: orphanContacts.map(slimLead),
    threads,
    counts: {
      contacts: contacts.length,
      pipelineTargets: pipeline.length,
      companiesWithPath: companies.length,
      gaps: gaps.length,
      latentLeads: orphanContacts.length,
      threads: threads.length,
      dueNudges: threadCounts.nudge ?? 0,
    },
  };
}
