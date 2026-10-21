/**
 * workday-sites.mjs — which Workday career sites does this user's portals.yml know?
 *
 * The scanner stores a Workday posting URL as `https://{tenant}.wdN.myworkdayjobs.com/job/...`
 * (no site segment), but the per-job JSON endpoint needs the site. The ladder
 * recovers it from the user's own tracked companies: `{host → [site, …]}`.
 */

import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { workdaySiteOf } from '../providers/workday.mjs';

/** Pure: `{host → sites[]}` from a parsed portals.yml. */
export function workdaySitesFromPortals(config) {
  const map = {};
  for (const entry of config?.tracked_companies || []) {
    const t = workdaySiteOf(entry);
    if (!t) continue;
    (map[t.host] ||= []);
    if (!map[t.host].includes(t.site)) map[t.host].push(t.site);
  }
  return map;
}

/** `{}` when portals.yml is missing or unreadable (the ladder then just can't recover a site). */
export function loadWorkdaySites(path = 'user/portals.yml') {
  try {
    if (!existsSync(path)) return {};
    return workdaySitesFromPortals(yaml.load(readFileSync(path, 'utf-8')));
  } catch {
    return {};
  }
}
