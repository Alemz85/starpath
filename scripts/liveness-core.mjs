/**
 * liveness-core.mjs — the pure part of posting liveness: text normalisation,
 * the expired/listing/apply signals, and classifyLiveness().
 *
 * Text is NORMALISED before any pattern runs (`normalizeForMatch`): diacritics
 * stripped, curly quotes straightened, whitespace collapsed. A page that says
 * "doesn’t exist" or "offre expirée" therefore matches the same pattern as its
 * plain-ASCII twin, so the patterns below are written in plain ASCII.
 *
 * Three callers share these signals: the API/HTML ladder (lib/liveness-ladder.mjs),
 * the Playwright rung (check-liveness.mjs, which polls `pollUntilDecisive`) and
 * the tests.
 */

/** Fold text for matching: NFKD, drop combining marks, straighten quotes, collapse spaces. */
export function normalizeForMatch(text = '') {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4`]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expiree|n'est plus disponible)/i,
];

export const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

export const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

export const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
];

export const MIN_CONTENT_CHARS = 300;

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

export function hasApplyControl(controls = []) {
  return controls.some((control) => {
    const label = normalizeForMatch(control);
    return APPLY_PATTERNS.some((pattern) => pattern.test(label));
  });
}

/** First hard-expired pattern in `text` (after normalisation), or undefined. */
export function matchExpiredText(text) {
  return firstMatch(HARD_EXPIRED_PATTERNS, normalizeForMatch(text));
}

/** First listing/search-page pattern in `text` (after normalisation), or undefined. */
export function matchListingText(text) {
  return firstMatch(LISTING_PAGE_PATTERNS, normalizeForMatch(text));
}

export function classifyLiveness({ status = 0, finalUrl = '', bodyText = '', applyControls = [] } = {}) {
  if (status === 404 || status === 410) {
    return { result: 'expired', reason: `HTTP ${status}` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', reason: `redirect to ${finalUrl}` };
  }

  const text = normalizeForMatch(bodyText);

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, text);
  if (expiredBody) {
    return { result: 'expired', reason: `pattern matched: ${expiredBody.source}` };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', reason: 'visible apply control detected' };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, text);
  if (listingPage) {
    return { result: 'expired', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'expired', reason: 'insufficient content — likely nav/footer only' };
  }

  return { result: 'uncertain', reason: 'content present but no visible apply control found' };
}

/**
 * Is this verdict final, or could a page that is still hydrating change it?
 * An apply control (active), an HTTP status, an error redirect, an explicit
 * expired phrase or a listing page are final. "Insufficient content" is what a
 * single-page app shows before it renders, and `uncertain` means nothing
 * conclusive yet — neither is final until the polling deadline.
 */
export function isDecisive({ result, reason = '' } = {}) {
  if (result === 'active') return true;
  if (result === 'expired') return !/insufficient content/.test(reason);
  return false;
}

/**
 * Sample the page every `intervalMs` until the verdict is decisive or
 * `timeoutMs` passes, then return the last verdict. Replaces a fixed 2-second
 * hydration wait: a server-rendered page answers on the first sample, a slow
 * SPA gets the full window.
 *
 * @param {object} deps
 * @param {() => Promise<object>} deps.sample returns classifyLiveness input
 * @param {number} [deps.intervalMs=250]
 * @param {number} [deps.timeoutMs=8000]
 * @param {(ms:number)=>Promise<void>} [deps.sleep]
 * @param {()=>number} [deps.now]
 * @returns {Promise<{result:string, reason:string, polls:number}>}
 */
export async function pollUntilDecisive({
  sample,
  intervalMs = 250,
  timeoutMs = 8000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const start = now();
  let polls = 0;
  let verdict;
  for (;;) {
    verdict = classifyLiveness(await sample());
    polls++;
    if (isDecisive(verdict)) break;
    if (now() - start + intervalMs > timeoutMs) break;
    await sleep(intervalMs);
  }
  return { ...verdict, polls };
}
