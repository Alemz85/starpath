/**
 * doctor-checks.mjs — Pure, side-effect-free logic for doctor.mjs diagnostics.
 *
 * All functions here are stateless and take only the data they need as
 * arguments (no file reads, no process.exit). The CLI wrapper (scripts/doctor.mjs)
 * owns all I/O and calls these to derive check results.
 *
 * Exports:
 *   buildUserLayerChecks(files)      — onboarding / user-layer file checks
 *   buildArtifactChecks(files, counts) — data-artifact presence + health
 *   buildCapabilityInventory(scripts, modes, flags) — what's ready vs missing
 *   buildPipelineSummary(counts)     — row counts for a glanceable summary
 *   countTsvDataRows(content)        — count non-header, non-empty TSV rows
 *   countMarkdownTableRows(content)  — count data rows in a markdown table
 *   countPipelineItems(content)      — count non-empty, non-header pipeline lines
 *   parseTsvHeader(content)          — return the first non-empty line split on \t
 *   validateScoreHistoryHeader(cols) — check expected columns are present
 *   validateScanHistoryHeader(cols)  — check expected columns are present
 */

// ── Expected TSV headers ────────────────────────────────────────────────────

const SCORE_HISTORY_REQUIRED_COLS = [
  'date', 'company', 'role', 'archetype', 'overall',
  'skills_match', 'ease_of_entry', 'strategic_fit',
];

const SCAN_HISTORY_REQUIRED_COLS = [
  'url', 'company', 'role', 'first_seen',
];

const COL_CACHE_REQUIRED_COLS = ['city', 'baseline_eur'];
const TAX_CACHE_REQUIRED_COLS = ['country', 'effective_rate'];
const OUTREACH_REQUIRED_COLS  = ['company', 'contact', 'channel', 'touch'];

// ── TSV/Markdown parsing helpers ────────────────────────────────────────────

/**
 * Count data rows in a TSV file (excludes header line + blank lines).
 * @param {string} content
 * @returns {number}
 */
export function countTsvDataRows(content) {
  if (!content || typeof content !== 'string') return 0;
  return content
    .split('\n')
    .slice(1) // skip header
    .filter(l => l.trim().length > 0)
    .length;
}

/**
 * Extract columns from the first non-empty line of a TSV file.
 * @param {string} content
 * @returns {string[]}
 */
export function parseTsvHeader(content) {
  if (!content || typeof content !== 'string') return [];
  const line = content.split('\n').find(l => l.trim().length > 0);
  if (!line) return [];
  return line.split('\t').map(c => c.trim());
}

/**
 * Count data rows in a markdown table (pipe-separated).
 * Skips the header row and the separator row (---|---).
 * @param {string} content
 * @returns {number}
 */
export function countMarkdownTableRows(content) {
  if (!content || typeof content !== 'string') return 0;
  const lines = content.split('\n').filter(l => l.trim().startsWith('|'));
  // First line = header, second line = separator (---), rest = data
  const dataLines = lines
    .filter(l => !/^\s*\|[\s-|]+\|\s*$/.test(l)) // drop separator rows
    .slice(1); // drop header row
  return dataLines.filter(l => l.trim().length > 0).length;
}

/**
 * Count pending pipeline entries (non-empty non-comment lines that look like URLs).
 * Pipeline.md is freeform; count lines containing http.
 * @param {string} content
 * @returns {number}
 */
export function countPipelineItems(content) {
  if (!content || typeof content !== 'string') return 0;
  return content
    .split('\n')
    .filter(l => /https?:\/\//.test(l))
    .length;
}

// ── Header validators ───────────────────────────────────────────────────────

/**
 * @param {string[]} cols - parsed header columns
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateScoreHistoryHeader(cols) {
  const lower = cols.map(c => c.toLowerCase());
  const missing = SCORE_HISTORY_REQUIRED_COLS.filter(r => !lower.includes(r));
  return { valid: missing.length === 0, missing };
}

/**
 * @param {string[]} cols
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateScanHistoryHeader(cols) {
  const lower = cols.map(c => c.toLowerCase());
  const missing = SCAN_HISTORY_REQUIRED_COLS.filter(r => !lower.includes(r));
  return { valid: missing.length === 0, missing };
}

/**
 * @param {string[]} cols
 * @param {string[]} required
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateCacheHeader(cols, required) {
  const lower = cols.map(c => c.toLowerCase());
  const missing = required.filter(r => !lower.includes(r));
  return { valid: missing.length === 0, missing };
}

/**
 * @param {string[]} cols
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateColCacheHeader(cols) {
  return validateCacheHeader(cols, COL_CACHE_REQUIRED_COLS);
}

/**
 * @param {string[]} cols
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateTaxCacheHeader(cols) {
  return validateCacheHeader(cols, TAX_CACHE_REQUIRED_COLS);
}

/**
 * @param {string[]} cols
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateOutreachHeader(cols) {
  return validateCacheHeader(cols, OUTREACH_REQUIRED_COLS);
}

// ── Check builders ──────────────────────────────────────────────────────────

/**
 * Build check results for user-layer onboarding files.
 *
 * @param {Object} files - map of logical name → file content or null
 *   { cv, profileYml, profileMd, portalsYml, articleDigest }
 * @returns {Array<{ pass: boolean, label: string, fix?: string|string[] }>}
 */
export function buildUserLayerChecks(files) {
  const checks = [];

  // cv.md
  if (files.cv != null) {
    checks.push({ pass: true, label: 'user/cv.md present' });
  } else {
    checks.push({
      pass: false,
      label: 'user/cv.md missing (onboarding required)',
      fix: 'Paste your CV into user/cv.md or run the onboarding flow in Claude',
    });
  }

  // profile.yml
  if (files.profileYml != null) {
    checks.push({ pass: true, label: 'user/profile.yml present' });
  } else {
    checks.push({
      pass: false,
      label: 'user/profile.yml missing (onboarding required)',
      fix: 'Run: cp config/profile.example.yml user/profile.yml  then edit it',
    });
  }

  // _profile.md (customization layer)
  if (files.profileMd != null) {
    checks.push({ pass: true, label: 'user/_profile.md present (customization layer)' });
  } else {
    checks.push({
      pass: false,
      label: 'user/_profile.md missing (archetypes / negotiation scripts not set)',
      fix: 'Start a Claude session and ask it to create user/_profile.md from your profile',
    });
  }

  // portals.yml
  if (files.portalsYml != null) {
    checks.push({ pass: true, label: 'user/portals.yml present (scan config)' });
  } else {
    checks.push({
      pass: false,
      label: 'user/portals.yml missing (scan will not run)',
      fix: [
        'Run: cp templates/portals.example.yml user/portals.yml',
        'Then add your target company portals and role keywords',
      ],
    });
  }

  // article-digest.md (optional)
  if (files.articleDigest != null) {
    checks.push({ pass: true, label: 'user/article-digest.md present (proof-point library)' });
  } else {
    checks.push({
      pass: true, // optional — not a blocker
      label: 'user/article-digest.md not found (optional — holds CV proof points)',
    });
  }

  return checks;
}

/**
 * Build check results for data-layer artifacts.
 *
 * @param {Object} files - map of logical name → content string or null
 *   { scanHistory, scoreHistory, scouting, applications, pipeline,
 *     outreach, colCache, taxCache }
 * @param {Object} counts - { companiesCount: number }
 * @returns {Array<{ pass: boolean, label: string, fix?: string|string[], note?: string }>}
 */
export function buildArtifactChecks(files, counts = {}) {
  const checks = [];
  const { companiesCount = 0 } = counts;

  // ── scan-history.tsv ─────────────────────────────────────────────────────
  if (files.scanHistory == null) {
    checks.push({
      pass: true, // created on first scan — not a blocker
      label: 'data/scan-history.tsv not yet created (created on first scan run)',
    });
  } else {
    const cols  = parseTsvHeader(files.scanHistory);
    const { valid, missing } = validateScanHistoryHeader(cols);
    const rows  = countTsvDataRows(files.scanHistory);
    if (valid) {
      checks.push({ pass: true, label: `data/scan-history.tsv present (${rows} posting${rows === 1 ? '' : 's'})` });
    } else {
      checks.push({
        pass: false,
        label: `data/scan-history.tsv has unexpected header (missing: ${missing.join(', ')})`,
        fix: 'This may indicate a version mismatch — check scripts/scan.mjs TSV columns',
      });
    }
  }

  // ── score-history.tsv ────────────────────────────────────────────────────
  if (files.scoreHistory == null) {
    checks.push({
      pass: true, // created on first evaluation
      label: 'data/score-history.tsv not yet created (created after first scouting evaluation)',
    });
  } else {
    const cols  = parseTsvHeader(files.scoreHistory);
    const { valid, missing } = validateScoreHistoryHeader(cols);
    const rows  = countTsvDataRows(files.scoreHistory);
    if (valid) {
      checks.push({ pass: true, label: `data/score-history.tsv present (${rows} evaluation${rows === 1 ? '' : 's'})` });
    } else {
      checks.push({
        pass: false,
        label: `data/score-history.tsv has unexpected header (missing: ${missing.join(', ')})`,
        fix: 'This may indicate a version mismatch — check modes/scouting.md TSV spec',
      });
    }
  }

  // ── scouting.md ──────────────────────────────────────────────────────────
  if (files.scouting == null) {
    checks.push({
      pass: true,
      label: 'data/scouting.md not yet created (created after first scouting evaluation)',
    });
  } else {
    const rows = countMarkdownTableRows(files.scouting);
    checks.push({ pass: true, label: `data/scouting.md present (${rows} scouted role${rows === 1 ? '' : 's'})` });
  }

  // ── applications.md ──────────────────────────────────────────────────────
  if (files.applications == null) {
    checks.push({
      pass: true,
      label: 'data/applications.md not yet created (created when first application is tracked)',
    });
  } else {
    const rows = countMarkdownTableRows(files.applications);
    checks.push({ pass: true, label: `data/applications.md present (${rows} application${rows === 1 ? '' : 's'} tracked)` });
  }

  // ── pipeline.md ──────────────────────────────────────────────────────────
  if (files.pipeline == null) {
    checks.push({
      pass: true,
      label: 'data/pipeline.md not yet created (URL inbox — populated by scan)',
    });
  } else {
    const items = countPipelineItems(files.pipeline);
    checks.push({ pass: true, label: `data/pipeline.md present (${items} pending URL${items === 1 ? '' : 's'} in inbox)` });
  }

  // ── outreach.md (round 3 artifact) ───────────────────────────────────────
  if (files.outreach == null) {
    checks.push({
      pass: true,
      label: 'data/outreach.md not yet created (outreach tracker — populated by contacto mode)',
    });
  } else {
    const cols  = parseTsvHeader(files.outreach.replace(/\|/g, '\t')); // md table → tsv-like
    const { valid } = validateOutreachHeader(cols);
    const rows  = countMarkdownTableRows(files.outreach);
    if (valid) {
      checks.push({ pass: true, label: `data/outreach.md present (${rows} outreach thread${rows === 1 ? '' : 's'})` });
    } else {
      checks.push({ pass: true, label: `data/outreach.md present (${rows} outreach thread${rows === 1 ? '' : 's'})` });
    }
  }

  // ── data/companies/ (round 1 deep-research dossiers) ─────────────────────
  checks.push({
    pass: true,
    label: `data/companies/ — ${companiesCount} company dossier${companiesCount === 1 ? '' : 's'} cached`,
    note: companiesCount === 0
      ? 'Run `npm run research -- <Company>` (or the deep mode) to generate dossiers'
      : undefined,
  });

  // ── col-cache.tsv ────────────────────────────────────────────────────────
  if (files.colCache == null) {
    checks.push({
      pass: true,
      label: 'data/col-cache.tsv not yet created (cost-of-living cache — populated on first scoring)',
    });
  } else {
    const cols  = parseTsvHeader(files.colCache);
    const { valid, missing } = validateColCacheHeader(cols);
    const rows  = countTsvDataRows(files.colCache);
    if (valid) {
      checks.push({ pass: true, label: `data/col-cache.tsv present (${rows} city baseline${rows === 1 ? '' : 's'})` });
    } else {
      checks.push({
        pass: false,
        label: `data/col-cache.tsv has unexpected header (missing: ${missing.join(', ')})`,
        fix: 'Delete data/col-cache.tsv and run a scoring to regenerate',
      });
    }
  }

  // ── tax-cache.tsv ────────────────────────────────────────────────────────
  if (files.taxCache == null) {
    checks.push({
      pass: true,
      label: 'data/tax-cache.tsv not yet created (tax rate cache — populated on first scoring)',
    });
  } else {
    const cols  = parseTsvHeader(files.taxCache);
    const { valid, missing } = validateTaxCacheHeader(cols);
    const rows  = countTsvDataRows(files.taxCache);
    if (valid) {
      checks.push({ pass: true, label: `data/tax-cache.tsv present (${rows} country rate${rows === 1 ? '' : 's'})` });
    } else {
      checks.push({
        pass: false,
        label: `data/tax-cache.tsv has unexpected header (missing: ${missing.join(', ')})`,
        fix: 'Delete data/tax-cache.tsv and run a scoring to regenerate',
      });
    }
  }

  return checks;
}

// ── Capability inventory ────────────────────────────────────────────────────

/**
 * The canonical list of CLI tools by category.
 * Each entry: { script, label, optional }
 */
export const CLI_TOOLS = [
  // Core pipeline
  { script: 'scan.mjs',               label: 'scan (portal scanner)',         optional: false },
  { script: 'merge-tracker.mjs',      label: 'merge-tracker',                 optional: false },
  { script: 'merge-scouting.mjs',     label: 'merge-scouting',                optional: false },
  { script: 'verify-pipeline.mjs',    label: 'verify-pipeline',               optional: false },
  { script: 'generate-pdf.mjs',       label: 'generate-pdf (CV/PDF output)',  optional: false },
  // Analysis
  { script: 'calibration-advisor.mjs', label: 'calibration-advisor',          optional: false },
  { script: 'cv-gap.mjs',             label: 'cv-gap (CV vs landscape)',       optional: false },
  { script: 'daily-brief.mjs',        label: 'daily-brief (what to do today)', optional: false },
  { script: 'analyze-patterns.mjs',   label: 'analyze-patterns',              optional: false },
  { script: 'positioning-intel.mjs',  label: 'positioning-intel',             optional: false },
  { script: 'whats-new.mjs',          label: 'whats-new (post-scan digest)',   optional: false },
  { script: 'followup-cadence.mjs',   label: 'followup-cadence',              optional: false },
  { script: 'outreach-cadence.mjs',   label: 'outreach-cadence',              optional: false },
  { script: 'check-story-bank.mjs',   label: 'check-story-bank',              optional: false },
  { script: 'check-liveness.mjs',     label: 'check-liveness',                optional: false },
  { script: 'compare-offers.mjs',     label: 'compare-offers',                optional: false },
  { script: 'company-research.mjs',   label: 'company-research (dossier CLI)', optional: false },
  { script: 'score-listing.mjs',      label: 'score-listing',                 optional: false },
  { script: 'ats-coverage.mjs',       label: 'ats-coverage',                  optional: false },
  { script: 'cv-sync-check.mjs',      label: 'cv-sync-check',                 optional: false },
  // Health / maintenance
  { script: 'dedup-tracker.mjs',      label: 'dedup-tracker',                 optional: false },
  { script: 'normalize-statuses.mjs', label: 'normalize-statuses',            optional: false },
  { script: 'promote-to-applications.mjs', label: 'promote-to-applications',  optional: false },
  { script: 'merge-scan-staging.mjs', label: 'merge-scan-staging (JobSpy merge)', optional: false },
  // Optional / one-time
  { script: 'peer-rank.mjs',          label: 'peer-rank',                     optional: true  },
  { script: 'training-roi.mjs',       label: 'training-roi',                  optional: true  },
];

/**
 * Build capability inventory checks.
 *
 * @param {Object} flags
 *   {
 *     scriptExists:    (scriptName: string) => boolean,
 *     modeCount:       number,
 *     jobspyPyExists:  boolean,
 *     jobspyVenvReady: boolean,
 *     storyBankExists: boolean,
 *   }
 * @returns {Array<{ pass: boolean, label: string, fix?: string }>}
 */
export function buildCapabilityInventory(flags) {
  const {
    scriptExists,
    modeCount = 0,
    jobspyPyExists = false,
    jobspyVenvReady = false,
    storyBankExists = false,
  } = flags;

  const checks = [];

  // Modes count
  checks.push({ pass: true, label: `${modeCount} Claude mode${modeCount === 1 ? '' : 's'} available (modes/)` });

  // CLI tools: group into present + missing
  const missing = CLI_TOOLS.filter(t => !t.optional && !scriptExists(t.script));
  const present = CLI_TOOLS.filter(t => scriptExists(t.script));

  checks.push({
    pass: missing.length === 0,
    label: missing.length === 0
      ? `All ${CLI_TOOLS.length} CLI tools present (scripts/)`
      : `${present.length}/${CLI_TOOLS.length} CLI tools present — missing: ${missing.map(t => t.script).join(', ')}`,
    fix: missing.length > 0 ? 'Pull the latest commits to restore missing scripts' : undefined,
  });

  // JobSpy aggregator scraper
  if (!jobspyPyExists) {
    checks.push({
      pass: false,
      label: 'JobSpy scraper not found (scripts/jobspy/scan.py)',
      fix: 'The JobSpy scanner supplements Greenhouse/Ashby/Lever results — pull latest to get it',
    });
  } else if (!jobspyVenvReady) {
    checks.push({
      pass: false,
      label: 'JobSpy scraper found but Python venv not set up',
      fix: 'Run: bash scripts/jobspy/setup.sh',
    });
  } else {
    checks.push({ pass: true, label: 'JobSpy aggregator scraper ready (Indeed + Google)' });
  }

  // Story bank
  if (storyBankExists) {
    checks.push({ pass: true, label: 'interview-prep/story-bank.md present (STAR+R story library)' });
  } else {
    checks.push({
      pass: true, // not a blocker — built incrementally
      label: 'interview-prep/story-bank.md not yet created (built as you prep for interviews)',
    });
  }

  return checks;
}

// ── Pipeline summary ────────────────────────────────────────────────────────

/**
 * Build a glanceable pipeline summary line for the doctor output.
 *
 * @param {Object} counts
 *   { scanned, scored, scouted, applied, pending }
 * @returns {{ label: string, lines: string[] }}
 */
export function buildPipelineSummary(counts) {
  const {
    scanned  = 0,
    scored   = 0,
    scouted  = 0,
    applied  = 0,
    pending  = 0,
  } = counts;

  const lines = [
    `  Scanned postings : ${scanned}`,
    `  Scored roles     : ${scored}`,
    `  Scouted roles    : ${scouted}`,
    `  Applications     : ${applied}`,
    `  Pending in inbox : ${pending}`,
  ];

  return { label: 'Pipeline snapshot', lines };
}
