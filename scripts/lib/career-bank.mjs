// career-bank.mjs — where the user's career bank lives.
//
// The career bank (`user/career-bank.md`) is the user's complete inventory of
// what they have done: education, work, projects, activities, skills with
// honest levels, languages and test scores, interests. CVs, cover letters,
// form answers and interview prep select from it; `user/cv.md` is the current
// one-page selection.
//
// Older installs call the file `user/article-digest.md`. Every reader goes
// through resolveCareerBank(), which prefers the new name and falls back to
// the old one, so those installs keep working until the user renames it.
// Plain ESM, zero deps.

import { existsSync } from 'fs';
import { join } from 'path';

/** Canonical path, relative to the data root. */
export const CAREER_BANK_PATH = 'user/career-bank.md';
/** Pre-rename path, read only when the canonical file is missing. */
export const LEGACY_CAREER_BANK_PATH = 'user/article-digest.md';
/** The one-line fix doctor suggests for a legacy install. */
export const CAREER_BANK_RENAME_FIX = `mv ${LEGACY_CAREER_BANK_PATH} ${CAREER_BANK_PATH}`;

/**
 * Find the career bank under `root` (the folder holding `user/`).
 *
 * @param {string} root
 * @param {{ exists?: (p: string) => boolean }} [opts]  injectable for tests
 * @returns {{ rel: string|null, path: string|null, legacy: boolean }}
 *   rel/path are null when neither file exists; legacy is true only when the
 *   old name was used.
 */
export function resolveCareerBank(root, { exists = existsSync } = {}) {
  for (const rel of [CAREER_BANK_PATH, LEGACY_CAREER_BANK_PATH]) {
    const path = join(root, rel);
    if (exists(path)) return { rel, path, legacy: rel === LEGACY_CAREER_BANK_PATH };
  }
  return { rel: null, path: null, legacy: false };
}
