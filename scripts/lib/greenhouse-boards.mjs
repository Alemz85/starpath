/**
 * greenhouse-boards.mjs — which Greenhouse boards does this user's portals.yml know?
 *
 * Many companies embed their Greenhouse board in their own site, so the board
 * API's `absolute_url` is a company page such as
 * `https://acme.com/careers/positions/123?gh_jid=123`. Nothing in that URL names
 * the board, so the liveness ladder and fetch-posting could not ask the API
 * about it and every such posting came back "not a posting URL on a supported
 * ATS". The posting id is the `gh_jid`; the board is recovered from the user's
 * own tracked Greenhouse companies whose name or slug matches the site's
 * domain. A match is a guess: a 404 on it never proves the posting closed.
 */

import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { isSafeSegment } from './ats-url.mjs';

const GH_HOST = /(^|\.)greenhouse\.io$/i;
const SLUG_IN = /(?:boards-api|job-boards(?:\.eu)?|boards(?:\.eu)?)\.greenhouse\.io\/(?:v1\/boards\/)?([^/?#]+)/i;

const squash = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** Pure: `[{company, slug, eu}]` for every Greenhouse entry of a parsed portals.yml. */
export function greenhouseBoardsFromPortals(config) {
  const out = [];
  for (const entry of config?.tracked_companies || []) {
    if (entry?.enabled === false) continue;
    const src = [entry?.api, entry?.careers_url].map((s) => String(s || '')).find((s) => SLUG_IN.test(s));
    const slug = src && SLUG_IN.exec(src)[1];
    if (!slug || !isSafeSegment(slug)) continue;
    if (out.some((b) => b.slug === slug)) continue;
    out.push({ company: String(entry.name || ''), slug, eu: /\.eu\.greenhouse\.io/i.test(String(entry.careers_url || '')) });
  }
  return out;
}

/** `[]` when portals.yml is missing or unreadable (embeds then stay unresolved). */
export function loadGreenhouseBoards(path = 'user/portals.yml') {
  try {
    if (!existsSync(path)) return [];
    return greenhouseBoardsFromPortals(yaml.load(readFileSync(path, 'utf-8')));
  } catch {
    return [];
  }
}

/**
 * The Greenhouse posting id of a company-hosted embed URL (`?gh_jid=<digits>`
 * on a non-Greenhouse https host), or null.
 */
export function greenhouseEmbedId(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' || GH_HOST.test(u.hostname)) return null;
  const id = u.searchParams.get('gh_jid');
  return id && /^\d{4,}$/.test(id) ? id : null;
}

/** The domain's own label: `careers.acme.co` → `acme`, `www.trade-x.com` → `tradex`. */
function siteLabel(hostname) {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  return squash(labels.length >= 2 ? labels[labels.length - 2] : labels[0] || '');
}

/**
 * Boards that may hold an embed URL's posting: the tracked Greenhouse
 * companies whose squashed name or slug equals the site's domain label, or
 * whose slug extends it (`traderepublic.com` → `traderepublicbank`).
 */
export function embedBoards(raw, boards = []) {
  if (!greenhouseEmbedId(raw)) return [];
  const label = siteLabel(new URL(String(raw).trim()).hostname);
  if (label.length < 2) return [];
  return boards.filter((b) => {
    const slug = squash(b.slug);
    return squash(b.company) === label || slug === label || slug.startsWith(label);
  });
}
