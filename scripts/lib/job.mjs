/**
 * job.mjs — the Job typedef every scanner provider returns, and the one place
 * that enforces its doctrine.
 *
 * @typedef {object} Job
 * @property {string}  title
 * @property {string}  url            per-POSTING identity: the public URL of this one
 *                                    posting (never a board or search page)
 * @property {string}  company        the portals.yml company name
 * @property {string}  [location]     the source's location string, unchanged
 * @property {string[]} [extraLocations] further locations the payload lists
 * @property {string|number|null} [postedDate] the true posting date as the ATS gave it
 *                                    (scan-core.parsePostingDate normalises it)
 * @property {string|null} [deadline] ISO date, ONLY when the source states one
 * @property {string}  [externalId]   the ATS-native posting id; identity is
 *                                    `<source>:<externalId>`. Absent → no id identity
 * @property {string}  [requisitionId] the requisition id: MANY-TO-ONE (reposts and
 *                                    multi-location roles share one). A label only,
 *                                    never an identity, alone or in a key
 * @property {{min:number|null, max:number|null, currency:string, period:string}} [salary]
 *                                    ONLY from real numeric figures in the payload;
 *                                    never inferred from text or from a range label
 *
 * The scan-history columns keep their wave-1 names (`posting_id`, `req_id`);
 * `externalId` → `posting_id`, `requisitionId` → `req_id`.
 */

import { cleanId } from './listing-fields.mjs';

const str = (v) => (typeof v === 'string' ? v.replace(/[\t\r\n]+/g, ' ').trim() : '');

const PERIODS = new Set(['year', 'month', 'week', 'day', 'hour']);

/**
 * Build a salary object from REAL figures, or null. A figure is real when it is
 * a finite positive number; a currency is a 3-letter code. One side may be
 * missing (a floor-only posting), but at least one figure must be.
 *
 * @param {{min?:unknown, max?:unknown, currency?:unknown, period?:unknown}} raw
 */
export function normalizeSalary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const min = num(raw.min);
  const max = num(raw.max);
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min > max) return null;
  const currency = /^[A-Za-z]{3}$/.test(String(raw.currency ?? '')) ? String(raw.currency).toUpperCase() : '';
  if (!currency) return null; // a bare number with no currency is not a salary
  const period = PERIODS.has(String(raw.period ?? '').toLowerCase()) ? String(raw.period).toLowerCase() : '';
  return { min, max, currency, period };
}

/**
 * Coerce a provider's raw posting into a Job, or null when it cannot be one
 * (no title or no per-posting URL). Third-party providers are held to the same
 * shape as the built-ins here.
 *
 * @param {object} raw
 * @param {{company:string}} ctx
 * @returns {Job|null}
 */
export function normalizeJob(raw, { company }) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title);
  const url = str(raw.url);
  if (!title || !url) return null;
  const job = {
    ...raw,
    title,
    url,
    company: str(raw.company) || company,
    location: str(raw.location),
    extraLocations: Array.isArray(raw.extraLocations) ? raw.extraLocations.map(str).filter(Boolean) : [],
    postedDate: raw.postedDate ?? null,
    deadline: raw.deadline || null,
    externalId: cleanId(raw.externalId),
    requisitionId: cleanId(raw.requisitionId),
  };
  const salary = normalizeSalary(raw.salary);
  if (salary) job.salary = salary; else delete job.salary;
  return job;
}
