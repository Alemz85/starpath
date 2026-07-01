// outreach-plan-core.mjs — pure logic for the `contacto` pre-flight dossier.
//
// THE PROBLEM THIS SOLVES
// A referral dramatically outperforms a cold application, and the system already
// has three outreach layers: who you KNOW (data/network.md → network-core), what
// you SENT (data/outreach.md → outreach-core cadence), and cached company
// research (data/companies/{slug}.md → company-research-core). But nothing
// stitched them together at the moment that matters — when the user says
// "reach out at {company}" and the `contacto` mode starts drafting. The mode
// went straight to a cold LinkedIn search even when the user already knew a
// peer on the team, had a pending thread with the hiring manager, or had burned
// two touches on a recruiter who went cold.
//
// This module assembles that context into ONE plan for ONE target company and
// recommends the *play* — the single next outreach move:
//
//   reply-handoff  someone already replied → continue that human conversation
//   nudge          a thread is due a follow-up → nudge it, don't open a new one
//   warm-direct    an untouched 1st-degree contact → message them directly
//   warm-intro     an untouched 2nd-degree contact → ask the bridge for an intro
//   wait           the active thread is on track → don't pester, wait it out
//   cold-search    nobody known / everyone exhausted → contacto Step 2 search
//
// Everything here is a pure function of its inputs — no filesystem, no clock,
// no network. The I/O wrapper (scripts/outreach-plan.mjs) resolves files and
// passes facts in. This module NEVER drafts message text and NEVER sends —
// it only tells the agent who to write to and where each ingredient lives.
// Candidate specifics (proof metric, name, location) stay in user/* and are
// read by the mode at draft time; nothing user-specific ships here.

import { companyKey, pathLabel } from './network-core.mjs';
import { classifyAll } from '../outreach-core.mjs';
import { rankStoriesForQuestion, resultIsQuantified } from './story-bank.mjs';

/* ───── helpers ─────────────────────────────────────────────────────────────── */

/** Person-name match key: lowercase, collapse whitespace. */
export function normName(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/* ───── threads: outreach history scoped to one company ─────────────────────── */

/**
 * Filter the collapsed outreach log down to one company and classify each
 * thread via the cadence state machine (outreach-core). Returns classified
 * entries in classifyAll's action order (nudge > waiting > cold > done),
 * each carrying { action, state, leverage, daysSince, nextNudge, reason,
 * priority } on top of the log fields. Pure.
 *
 * @param {Array}  collapsedContacts  from outreach-cadence.mjs `collapse(parseLog(...))`
 * @param {string} companyName
 * @param {string} todayStr           YYYY-MM-DD
 */
export function companyThreads(collapsedContacts, companyName, todayStr) {
  const ck = companyKey(companyName);
  const mine = (collapsedContacts || []).filter((c) => companyKey(c.company) === ck);
  if (!mine.length) return [];
  return classifyAll(mine, todayStr).entries;
}

/* ───── merge: network paths × outreach threads ──────────────────────────────── */

/**
 * Annotate each referral path (from network-core's pathsForCompany) with its
 * outreach-thread state when the same person already has a logged thread —
 * matched by normalized name. `thread: null` means the path is untouched
 * (no message ever sent), which is exactly what makes it actionable. Pure.
 */
export function annotatePaths(paths, threads) {
  const byName = new Map();
  for (const t of threads || []) byName.set(normName(t.contact), t);
  return (paths || []).map((p) => {
    const t = byName.get(normName(p.name)) || null;
    return {
      ...p,
      thread: t
        ? {
            action: t.action,
            state: t.state,
            touches: t.touches ?? null,
            lastTouch: t.lastTouch ?? null,
            nextNudge: t.nextNudge ?? null,
          }
        : null,
    };
  });
}

/* ───── the decision: which play to run ──────────────────────────────────────── */

export const PLAY_LABEL = {
  'reply-handoff': 'REPLY — continue the live thread',
  nudge: 'NUDGE — follow up the existing thread',
  'warm-direct': 'WARM DIRECT — message a contact you know',
  'warm-intro': 'WARM INTRO — ask your bridge for an introduction',
  wait: 'WAIT — the active thread is on track',
  'cold-search': 'COLD SEARCH — find the right person first',
};

function targetFromPath(p) {
  return {
    name: p.name,
    title: p.title || null,
    leverage: p.leverage || null,
    warmth: p.warmth ?? null,
    degree: p.degree ?? null,
    via: p.via || null,
  };
}

function targetFromThread(t) {
  return {
    name: t.contact,
    title: t.title || null,
    leverage: t.leverage || null,
    warmth: null,
    degree: null,
    via: null,
  };
}

/**
 * Pick the recommended play for one company from the annotated referral paths
 * and the classified threads. Priority order (most valuable asset first):
 *
 *   1. replied thread      — a live conversation beats everything; hand off.
 *   2. due nudge           — an open thread that's overdue; nudge it before
 *                            opening any parallel first touch.
 *   3. untouched warm path — the referral asset: 1st-degree → direct message,
 *                            2nd-degree → intro via the bridge. An on-track
 *                            waiting thread doesn't block this (a peer thread
 *                            and a recruiter thread can coexist) but is flagged
 *                            as a caution so the user coordinates the asks.
 *   4. waiting thread      — everything known is in flight and on track: wait.
 *   5. cold-search         — nobody mapped, or everyone mapped is exhausted.
 *
 * Cold threads never become targets again — they surface as cautions ("don't
 * re-touch X") mirroring contacto.md's 2-touches-then-switch rule. Pure.
 *
 * @param {object} args  { paths: annotated paths (ranked, warmest first), threads }
 * @returns {object} { play, target, channel, reason, cautions: [] }
 */
export function recommendPlay({ paths = [], threads = [] } = {}) {
  const cautions = [];
  const colds = threads.filter((t) => t.action === 'cold');
  if (colds.length) {
    cautions.push(
      `Cold thread${colds.length === 1 ? '' : 's'} — do not re-touch: ` +
      colds.map((t) => t.contact).join(', ') + '.',
    );
  }

  // 1. A reply is a conversation, not a cadence step.
  const replied = threads.find((t) => t.action === 'done');
  if (replied) {
    return {
      play: 'reply-handoff',
      target: targetFromThread(replied),
      channel: 'Reply inside the existing thread',
      reason: `${replied.contact} already replied — continue that conversation; a new first touch would be noise.`,
      cautions,
    };
  }

  // 2. Due nudges, most valuable first (classifyAll already sorted by priority).
  const nudge = threads.find((t) => t.action === 'nudge');
  const untouched = paths.filter((p) => !p.thread);
  if (nudge) {
    if (untouched.length) {
      cautions.push(
        `Untouched warm path also available: ${untouched[0].name}` +
        `${untouched[0].title ? ` (${untouched[0].title})` : ''} — an option if the nudge stays silent.`,
      );
    }
    return {
      play: 'nudge',
      target: targetFromThread(nudge),
      channel: 'Same thread, new angle (see contacto Step 8)',
      reason: nudge.reason || 'A follow-up is due on this thread.',
      cautions,
    };
  }

  // 3. Untouched warm paths — the referral asset. Paths arrive ranked warmest
  //    first (network-core folds strength × degree × recency × leverage).
  const waiting = threads.filter((t) => t.action === 'waiting');
  if (untouched.length) {
    const best = untouched[0];
    if (waiting.length) {
      cautions.push(
        `Active thread with ${waiting[0].contact} is on track (next nudge ${waiting[0].nextNudge ?? 'n/d'}) — ` +
        'coordinate the two asks; don\'t make the same request twice in parallel.',
      );
    }
    if (best.degree === 2) {
      const bridge = best.via || 'your mutual contact';
      return {
        play: 'warm-intro',
        target: targetFromPath(best),
        channel: `Ask ${bridge} for the introduction`,
        reason: `${best.name} is a 2nd-degree path — a warm intro through ${bridge} beats any cold reach.`,
        cautions,
      };
    }
    return {
      play: 'warm-direct',
      target: targetFromPath(best),
      channel: 'Direct message / email — you know them; skip the cold connection request',
      reason: `${best.name} is your warmest untouched path in (${best.relationship || 'known'} tie` +
        `${best.leverage && best.leverage !== 'neutral' ? `, ${best.leverage}` : ''}).`,
      cautions,
    };
  }

  // 4. Everything known is in flight and on track.
  if (waiting.length) {
    const t = waiting[0];
    return {
      play: 'wait',
      target: targetFromThread(t),
      channel: null,
      reason: `Thread with ${t.contact} is on track — next nudge ${t.nextNudge ?? 'n/d'}. Another touch now would pester.`,
      cautions,
    };
  }

  // 5. Nothing usable — go find the right person (contacto Step 2).
  const exhausted = paths.length > 0; // every mapped path already has a (cold) thread
  return {
    play: 'cold-search',
    target: null,
    channel: null,
    reason: exhausted
      ? 'Every mapped contact here already has an exhausted thread — find a NEW person (contacto Step 2).'
      : 'No mapped contact at this company — find the right person first (contacto Step 2), then add them to data/network.md.',
    cautions,
  };
}

/* ───── story ammo: quantified proof for the message's proof sentence ────────── */

/**
 * Rank story-bank stories against the target role title(s) and surface the top
 * few as "proof ammo" — quantified results the drafting step can lean on when
 * it writes the message's proof sentence (the exact metric still comes from
 * user/cv.md at draft time; these point at which story to pull it from). Pure.
 */
export function pickStoryAmmo(stories, roleTitles = [], { limit = 3 } = {}) {
  const question = (roleTitles || []).filter(Boolean).join(' ');
  if (!question.trim() || !(stories || []).length) return [];
  return rankStoriesForQuestion(stories, question, { limit }).map(({ story, score, fit }) => ({
    title: story.title,
    result: story.result || '',
    quantified: resultIsQuantified(story),
    themes: story.themes || [],
    score,
    fit,
  }));
}

/* ───── hook source: where the message's opening line comes from ─────────────── */

/**
 * Decide the best available *hook* source (contacto Step 4's opening line), in
 * the same preference order the mode documents: fresh deep-research Talking
 * Points > stale research (durable points only) > the scouting report's company
 * context > nothing cached (research the hook fresh). Pure.
 *
 * @param {object} research  { exists, state?, ageDays?, valid?, path? }
 * @param {object} report    { exists, path?, tier? }
 */
export function hookSource(research = {}, report = {}) {
  if (research.exists && research.valid !== false && research.state === 'fresh') {
    return {
      source: 'research-fresh',
      detail: `Fresh deep research (${research.path || 'data/companies/…'}) — mine its Talking Points for the hook and Team & Role Context for targeting.`,
    };
  }
  if (research.exists && research.valid !== false) {
    return {
      source: 'research-stale',
      detail: `Stale deep research (${research.ageDays ?? '?'}d old, ${research.path || 'data/companies/…'}) — use durable talking points only; re-verify anything tied to Recent Signals, or re-run deep mode.`,
    };
  }
  if (report.exists) {
    return {
      source: 'report',
      detail: `Scouting report on disk (${report.path || 'reports/…'}) — mine its company context / role summary for the hook.`,
    };
  }
  return {
    source: 'none',
    detail: 'No cached hook — pull it from the JD, the company blog, or recent news (and consider running deep mode to cache reusable research).',
  };
}

/* ───── assembly ─────────────────────────────────────────────────────────────── */

/**
 * Assemble the full outreach plan for one company. Pure: facts in, plan out.
 *
 * @param {object} input
 *   - company   {string}
 *   - roles     {Array}   [{ role, score, source }] — pipeline roles at this company
 *   - paths     {Array}   ranked referral paths (network-core pathsForCompany().contacts)
 *   - threads   {Array}   classified outreach threads (companyThreads())
 *   - research  {object}  { exists, state?, ageDays?, valid?, path? }
 *   - report    {object}  { exists, path?, tier? }
 *   - prep      {object}  { exists, path? }  — interview-prep/{Company} - {Role}.md
 *   - stories   {Array}   parsed story bank (story-bank.mjs parseStoryBank())
 *   - today     {string}  YYYY-MM-DD
 */
export function assemblePlan({
  company,
  roles = [],
  paths = [],
  threads = [],
  research = { exists: false },
  report = { exists: false },
  prep = { exists: false },
  stories = [],
  today = null,
} = {}) {
  const annotated = annotatePaths(paths, threads);
  const recommendation = recommendPlay({ paths: annotated, threads });
  const storyAmmo = pickStoryAmmo(stories, roles.map((r) => r.role), { limit: 3 });
  const hook = hookSource(research, report);

  return {
    company: String(company || '').trim(),
    date: today,
    inPipeline: roles.length > 0,
    roles,
    recommendation,
    paths: annotated,
    threads,
    ingredients: {
      hook,
      research,
      report,
      prep,
      storyAmmo,
    },
    counts: {
      paths: annotated.length,
      untouchedPaths: annotated.filter((p) => !p.thread).length,
      threads: threads.length,
      dueNudges: threads.filter((t) => t.action === 'nudge').length,
    },
  };
}

/* ───── renderer: the human dashboard ────────────────────────────────────────── */

const THREAD_ICON = { nudge: 'NUDGE', waiting: 'waiting', cold: 'COLD', done: 'replied' };

/** Render a plan as a compact, scannable text dashboard. Pure: plan → string. */
export function renderPlan(plan) {
  const L = [];
  L.push(`Outreach plan — ${plan.company}${plan.date ? ` (${plan.date})` : ''}`);
  if (plan.inPipeline) {
    L.push(`Targeting: ${plan.roles.map((r) => `${r.role} (${r.score}/10)`).join(' · ')}`);
  } else {
    L.push('(not in your pipeline — speculative outreach)');
  }
  L.push('');

  // ── The play. ──
  const rec = plan.recommendation;
  L.push(`▶ Play: ${PLAY_LABEL[rec.play] || rec.play}`);
  L.push(`  ${rec.reason}`);
  if (rec.target) {
    const t = rec.target;
    const bits = [t.title, t.leverage && t.leverage !== 'neutral' ? t.leverage : null]
      .filter(Boolean).join(' · ');
    L.push(`  Target: ${t.name}${bits ? `  (${bits})` : ''}`);
  }
  if (rec.channel) L.push(`  Channel: ${rec.channel}`);
  for (const c of rec.cautions || []) L.push(`  ⚠ ${c}`);
  L.push('');

  // ── Warm paths. ──
  if (plan.paths.length) {
    L.push(`── Referral paths (${plan.counts.untouchedPaths} untouched of ${plan.paths.length}) ──`);
    for (const p of plan.paths) {
      const tag = p.thread ? `  [thread: ${THREAD_ICON[p.thread.action] || p.thread.action}]` : '';
      L.push(`  • [${(p.warmth ?? 0).toFixed(1)}] ${pathLabel(p)}${tag}`);
    }
    L.push('');
  }

  // ── Threads. ──
  if (plan.threads.length) {
    L.push(`── Outreach threads at this company (${plan.threads.length}) ──`);
    for (const t of plan.threads) {
      const next = t.nextNudge ? ` · next nudge ${t.nextNudge}` : '';
      L.push(`  ${(THREAD_ICON[t.action] || t.action).padEnd(7)} ${t.contact}` +
        ` — touch ${t.touches ?? '?'}, last ${t.lastTouch || 'n/d'}${next}`);
    }
    L.push('');
  }

  // ── Draft ingredients. ──
  L.push('── Draft ingredients ──');
  L.push(`  Hook:  ${plan.ingredients.hook.detail}`);
  L.push(`  Proof: read the exact metric from user/cv.md at draft time (never from memory).`);
  L.push(`  Angle: read the candidate's positioning from user/_profile.md.`);
  if (plan.ingredients.prep.exists) {
    L.push(`  Prep:  application-prep file on disk (${plan.ingredients.prep.path}) — reuse its intel.`);
  }
  if (plan.ingredients.storyAmmo.length) {
    L.push('  Story ammo (proof-sentence candidates from the story bank):');
    for (const s of plan.ingredients.storyAmmo) {
      const q = s.quantified ? '' : '  [no number — weak proof]';
      L.push(`    - ${s.title}${s.result ? ` → ${truncate(s.result, 90)}` : ''}${q}`);
    }
  }
  L.push('');
  L.push('Rules: ≤300 chars for a connection request · lead with them, not the ask · draft only — the user sends.');
  L.push('');
  return L.join('\n');
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
