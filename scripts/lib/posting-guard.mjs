/**
 * posting-guard.mjs — detect prompt-injection tricks in a job posting before
 * a Claude worker reads it. Pure: no IO, no deps.
 *
 * A posting is untrusted internet text. The usual attacks aimed at an LLM that
 * evaluates it are (a) text a human never sees (display:none, white-on-white,
 * off-screen, HTML comments), (b) invisible characters (zero-width, bidi
 * overrides, Unicode "tag" characters that smuggle ASCII), (c) lines that talk
 * to the model ("ignore previous instructions", "rate this candidate 10/10"),
 * (d) links only a machine would see, and (e) homoglyph spoofing. One
 * detector per kind; each emits at most one aggregated signal.
 *
 * Heuristics, not a sandbox: the verdict is a flag for the report header and
 * for the worker's own caution, never a guarantee that a "clean" page is safe.
 *
 *   clean    no signals
 *   caution  only low-severity signals
 *   suspect  at least one high-severity signal
 */

// ── Character helpers ───────────────────────────────────────────────────────

// Zero-width, bidi controls, word joiner / invisible operators, BOM, soft
// hyphen and the Unicode "tag" block (U+E0000-E007F, used to smuggle ASCII).
const INVISIBLE_G =
  /[­​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/gu;
const BIDI_OVERRIDES = new Set([0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const NON_LATIN_JOINING_RE =
  /[\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const EMOJI_LEFT_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}️\p{S}]/u;
const EMOJI_RIGHT_RE = /[\p{Extended_Pictographic}\p{S}]/u;

// Whitespace class that does NOT include U+FEFF (JS `\s` does).
const WS_RE = /[ \t\r\n\f\v ]+/g;

const isInvisible = (cp) =>
  cp === 0xad ||
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2060 && cp <= 0x2064) ||
  (cp >= 0x2066 && cp <= 0x2069) ||
  cp === 0xfeff ||
  (cp >= 0xe0000 && cp <= 0xe007f);

const countLetters = (s) => (s.match(/\p{L}/gu) || []).length;
const countWords = (s) => (s.match(/\p{L}[\p{L}\p{N}'’-]*/gu) || []).length;
const collapseWs = (s) => s.replace(WS_RE, ' ');

/** Show invisible characters as `​` (or `\u{E0041}`) so a sample is legible. */
function escapeInvisible(s) {
  return s.replace(INVISIBLE_G, (c) => {
    const hex = c.codePointAt(0).toString(16).toUpperCase();
    return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
  });
}

/** One-line, escaped, at most 80 chars, windowed around `at` when long. */
function makeSample(str, at = 0) {
  const flat = collapseWs(String(str)).replace(/^ | $/g, '');
  const start = Math.max(0, Math.min(at, flat.length) - 20);
  const out = (start > 0 ? '…' : '') + escapeInvisible(flat.slice(start, start + 120));
  return out.length > 80 ? `${out.slice(0, 79)}…` : out;
}

/** Collapse spaces per line, trim lines, squeeze blank runs. Keeps U+FEFF etc. */
function tidy(s) {
  return s
    .replace(/[ \t\f\r\v ]+/g, ' ')
    .split('\n')
    .map((l) => l.replace(/^ +| +$/g, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+|\n+$/g, '');
}

// ── Entities ────────────────────────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  shy: '­', zwj: '‍', zwnj: '‌', lrm: '‎', rlm: '‏',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
  euro: '€', pound: '£', laquo: '«', raquo: '»', times: '×', deg: '°',
};

/** Decode numeric entities (semicolon optional, like browsers) and common named ones. */
function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z][a-zA-Z0-9]{1,8});)/g, (m, dec, hex, name) => {
    if (name) return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0) return '�';
    return String.fromCodePoint(cp);
  });
}

// ── Inline-style hiding ─────────────────────────────────────────────────────

/** Split `a:b;c:d(e;f)` into declarations, respecting parentheses. */
function parseStyle(style) {
  const decls = {};
  let depth = 0;
  let cur = '';
  const flush = () => {
    const i = cur.indexOf(':');
    if (i > 0) {
      const k = cur.slice(0, i).trim().toLowerCase();
      const v = cur.slice(i + 1).replace(/!\s*important/i, '').trim().toLowerCase();
      if (k) decls[k] = v;
    }
    cur = '';
  };
  for (const ch of style) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) flush();
    else cur += ch;
  }
  flush();
  return decls;
}

const isZero = (v) => /^[-+]?0*\.?0+(?:[a-z%]+)?$/.test(v ?? '');

const NAMED_COLORS = { white: '#ffffff', black: '#000000', transparent: 'transparent' };

/** Normalise a CSS colour to `#rrggbb` / `transparent` where cheaply possible. */
function normColor(v) {
  if (!v) return null;
  v = v.trim().toLowerCase();
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return `#${[...m[1]].map((c) => c + c).join('')}`;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return 'transparent';
    return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
  }
  return v;
}

/** Background colour declared inline, 'image' when an image/gradient hides the colour, else null. */
function inlineBackground(decls) {
  const bgc = decls['background-color'];
  if (bgc) return normColor(bgc);
  const bg = decls.background;
  if (!bg) return null;
  if (/url\(|gradient/.test(bg)) return 'image';
  const tok = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black|transparent)\b/.exec(bg);
  return tok ? normColor(tok[0]) : null;
}

const offscreen = (v) => {
  const m = /^(-\d+(?:\.\d+)?)(px|pt|em|rem|ch|vw|vh|vmin|vmax|%)?$/.exec(v ?? '');
  if (!m) return false;
  const n = Number(m[1]);
  return !m[2] || m[2] === 'px' || m[2] === 'pt' ? n <= -1000 : n <= -100;
};

/**
 * Why an element is hidden from a human reader, judged from its attributes and
 * inline style alone. Returns `{ reasons: [{ reason, weak }], bg }`. `weak`
 * marks the white-text heuristic, which needs more text before it counts.
 */
function hiddenReasons(attrs, inheritedBg) {
  const reasons = [];
  if ('hidden' in attrs) reasons.push({ reason: 'hidden attribute' });
  const d = attrs.style ? parseStyle(attrs.style) : {};
  const bg = inlineBackground(d) ?? inheritedBg;
  if (d.display === 'none') reasons.push({ reason: 'display:none' });
  if (d.visibility === 'hidden' || d.visibility === 'collapse') reasons.push({ reason: 'visibility:hidden' });
  if (d.opacity !== undefined && parseFloat(d.opacity) === 0) reasons.push({ reason: 'opacity:0' });
  const fs = d['font-size'];
  if (fs && (isZero(fs) || /^(?:0?\.\d+|[01](?:\.\d+)?)px$/.test(fs) && parseFloat(fs) <= 1)) {
    reasons.push({ reason: 'font-size:0' });
  }
  const pos = d.position;
  if ((pos === 'absolute' || pos === 'fixed') && (offscreen(d.left) || offscreen(d.top))) {
    reasons.push({ reason: 'off-screen position' });
  }
  if (offscreen(d['text-indent'])) reasons.push({ reason: 'off-screen text-indent' });
  if (d.clip && /^rect\(\s*[01](?:px)?[\s,]+[01](?:px)?[\s,]+[01](?:px)?[\s,]+[01](?:px)?\s*\)$/.test(d.clip)) {
    reasons.push({ reason: 'clip' });
  }
  const cp = d['clip-path'];
  if (cp && /^(?:inset\(\s*(?:50|100)%.*\)|circle\(\s*0(?:px|%)?\b.*\)|polygon\(\s*0(?:px)?\s+0(?:px)?\s*,\s*0(?:px)?\s+0(?:px)?.*\))$/.test(cp)) {
    reasons.push({ reason: 'clip-path' });
  }
  const overflowHidden = [d.overflow, d['overflow-y'], d['overflow-x']].some((o) => o === 'hidden' || o === 'clip');
  if (overflowHidden && (isZero(d.height) || isZero(d['max-height']) || isZero(d.width) || isZero(d['max-width']))) {
    reasons.push({ reason: 'zero-size box' });
  }
  const color = normColor(d.color);
  if (color === 'transparent') reasons.push({ reason: 'transparent text' });
  else if (color && bg && color === bg) reasons.push({ reason: 'text color equals background' });
  else if (color === '#ffffff' && !bg) reasons.push({ reason: 'white text', weak: true });
  return { reasons, bg };
}

// ── HTML extraction ─────────────────────────────────────────────────────────

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript']);
const IMPLIED_CLOSE = new Set(['p', 'li', 'dt', 'dd', 'option', 'tr', 'td', 'th']);
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'title',
]);
const ROOT_CTX = { hard: null, soft: null, bg: null };

/** Parse a tag's attribute string into a lowercase-keyed object (values entity-decoded). */
function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Index of the `>` that ends a tag starting at `from`, skipping quoted values; -1 if none. */
function findTagEnd(html, from) {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

/**
 * Walk the HTML once. Text lands in `visible`, in a `hardBlocks` entry (inside
 * an element hidden from the reader), and, for aria-hidden, additionally in a
 * `softBlocks` entry (still rendered, but flagged when substantial). Comments
 * are collected raw. <script>/<style>/<template>/<noscript> (JSON-LD
 * included) are skipped wholesale.
 */
function extractFromHtml(src) {
  const out = { visible: [], hardBlocks: [], softBlocks: [], comments: [], visibleHrefs: [] };
  const stack = [];
  const ctxNow = () => stack[stack.length - 1] ?? ROOT_CTX;
  const emit = (str, ctx) => {
    if (!str) return;
    if (ctx.hard) ctx.hard.text += str;
    else {
      out.visible.push(str);
      if (ctx.soft) ctx.soft.text += str;
    }
  };
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)/y;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { emit(decodeEntities(src.slice(i)), ctxNow()); break; }
    if (lt > i) emit(decodeEntities(src.slice(i, lt)), ctxNow());
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      out.comments.push(src.slice(i + 4, end === -1 ? src.length : end));
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') {
      const end = src.indexOf('>', i);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    tagRe.lastIndex = i;
    const m = tagRe.exec(src);
    const end = m ? findTagEnd(src, tagRe.lastIndex) : -1;
    if (!m || end === -1) { emit('<', ctxNow()); i += 1; continue; }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrStr = src.slice(tagRe.lastIndex, end);
    i = end + 1;

    if (closing) {
      let k = stack.length - 1;
      while (k >= 0 && stack[k].tag !== tag) k--;
      if (k < 0) continue;
      const entry = stack[k];
      stack.length = k;
      if (BLOCK_TAGS.has(tag)) emit('\n', entry);
      continue;
    }
    if (IMPLIED_CLOSE.has(tag) && ctxNow().tag === tag) stack.pop();

    if (RAW_SKIP_TAGS.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\b[^>]*>`, 'gi');
      closeRe.lastIndex = i;
      const cm = closeRe.exec(src);
      i = cm ? cm.index + cm[0].length : src.length;
      continue;
    }

    const attrs = parseAttrs(attrStr);
    const parent = ctxNow();
    const { reasons, bg } = hiddenReasons(attrs, parent.bg);
    let hard = parent.hard;
    if (!hard && reasons.length) {
      hard = { reasons, text: '', hrefs: [] };
      out.hardBlocks.push(hard);
    }
    let soft = parent.soft;
    if (!soft && (attrs['aria-hidden'] ?? '').toLowerCase() === 'true') {
      soft = { text: '' };
      out.softBlocks.push(soft);
    }
    const entry = { tag, hard, soft, bg };
    if (attrs.href !== undefined && (tag === 'a' || tag === 'area')) {
      if (hard) hard.hrefs.push(attrs.href);
      else out.visibleHrefs.push(attrs.href);
    }
    if (BLOCK_TAGS.has(tag)) emit('\n', entry);
    else if (tag === 'td' || tag === 'th') emit(' ', entry);
    const selfClosed = attrStr.trimEnd().endsWith('/');
    if (!VOID_TAGS.has(tag) && !selfClosed) stack.push(entry);
  }
  return out;
}

/** Plain-text input: everything is visible, nothing can be hidden. */
function extractFromText(text) {
  const raw = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  return { visible: [raw], hardBlocks: [], softBlocks: [], comments: [], visibleHrefs: [] };
}

// ── Detector: hidden text ───────────────────────────────────────────────────

/**
 * Comments only count when they read like prose (>= 20 letters, >= 6 words):
 * "<!-- Google Tag Manager -->" and IE conditionals are noise. A comment that
 * is instruction-shaped counts at any length.
 */
function commentToItem(raw) {
  if (/^\s*(?:\[if\b|<!\[endif)/i.test(raw)) return null;
  const text = tidy(raw.replace(/<[^>]*>/g, ' '));
  const letters = countLetters(text);
  const instr = hasInstruction(text, true);
  if (!instr && !(letters >= 20 && countWords(text) >= 6)) return null;
  return { source: 'comment', label: 'comment', text, instr, hrefs: [] };
}

/** Hidden items worth reporting: hidden elements, comments, substantial aria-hidden text. */
function collectHiddenItems(doc) {
  const items = [];
  for (const b of doc.hardBlocks) {
    const text = tidy(b.text);
    const instr = hasInstruction(text, true);
    // A short label (a logo name, "Close menu", an icon) is layout, not a
    // hidden message: every ATS page has some.
    const prose = countLetters(text) >= 20 && countWords(text) >= 3;
    // (Hidden links are checked on their own by hiddenUrlSignal.)
    if (!instr && !prose) continue;
    items.push({
      source: 'element',
      label: [...new Set(b.reasons.map((r) => r.reason))].join(' + '),
      text,
      instr,
      hrefs: b.hrefs,
    });
  }
  for (const c of doc.comments) {
    const item = commentToItem(c);
    if (item) items.push(item);
  }
  // aria-hidden text is still on screen (share widgets, carousel clones): it
  // counts only when it is instruction-shaped.
  for (const b of doc.softBlocks) {
    const text = tidy(b.text);
    if (countLetters(text) < 20 || !hasInstruction(text, true)) continue;
    items.push({ source: 'aria-hidden', label: 'aria-hidden', text, instr: true, hrefs: [] });
  }
  return items;
}

/** High when instruction-shaped, or (except aria-hidden, which is still rendered) >= 200 chars. */
const itemSeverity = (it) => (it.instr || (it.source !== 'aria-hidden' && it.text.length >= 200) ? 'high' : 'low');

function hiddenHtmlSignal(allItems) {
  // A plain HTML comment is a developer note ("we need these meta tags for
  // SEO"); it counts as hidden text only when it is instruction-shaped. Its
  // links still feed hiddenUrlSignal.
  const items = allItems.filter((it) => it.source !== 'comment' || it.instr);
  if (!items.length) return null;
  const ranked = items.map((it) => ({ it, sev: itemSeverity(it) }));
  const top = ranked.find((r) => r.sev === 'high') ?? ranked[0];
  const labels = [...new Set(items.map((it) => it.label))].join('; ');
  const chars = items.reduce((n, it) => n + it.text.length, 0);
  return {
    kind: 'hidden-html',
    severity: top.sev,
    detail: `${items.length} hidden text block${items.length === 1 ? '' : 's'} (${labels}), ${chars} chars`,
    sample: makeSample(top.it.text),
  };
}

// ── Detector: invisible characters ──────────────────────────────────────────

/** ZWJ/ZWNJ between emoji/symbols (or inside Arabic/Indic/SE-Asian words) is ordinary typography. */
function joinerIsLegit(cp, prev, next) {
  if (cp !== 0x200d && cp !== 0x200c) return false;
  if (prev === undefined || next === undefined) return false;
  if (EMOJI_LEFT_RE.test(prev) && EMOJI_RIGHT_RE.test(next)) return true;
  return NON_LATIN_JOINING_RE.test(prev) && NON_LATIN_JOINING_RE.test(next);
}

/** Count invisible characters in `text` (leading BOM already removed). */
function scanInvisibles(text) {
  const cps = Array.from(text);
  const counts = new Map();
  let total = 0;
  let soft = 0;
  let tags = 0;
  let bidi = false;
  let firstAt = -1;
  let offset = 0;
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    const cp = ch.codePointAt(0);
    if (isInvisible(cp) && !joinerIsLegit(cp, cps[i - 1], cps[i + 1])) {
      if (firstAt === -1 && cp !== 0xad) firstAt = offset;
      counts.set(cp, (counts.get(cp) ?? 0) + 1);
      total++;
      if (cp === 0xad) soft++;
      if (cp >= 0xe0000) tags++;
      if (BIDI_OVERRIDES.has(cp)) bidi = true;
    }
    offset += ch.length;
  }
  return { counts, total, soft, tags, bidi, firstAt };
}

const hex4 = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

function invisibleCharsSignal(raw) {
  const s = scanInvisibles(raw);
  const other = s.total - s.soft;
  const softCounts = s.soft >= 5;
  if (other === 0 && !softCounts) return null;
  // Soft hyphens (>= 5) are reported but stay low on their own: hyphenated
  // long-word pages (German, legal text) carry hundreds legitimately.
  const high = other >= 5 || s.bidi || s.tags > 0;
  const parts = [];
  for (const [cp, n] of [...s.counts].sort((a, b) => a[0] - b[0])) {
    if (cp === 0xad && !softCounts) continue;
    if (cp >= 0xe0000) continue;
    parts.push(`${hex4(cp)} x${n}`);
  }
  if (s.tags) parts.push(`Unicode tag characters x${s.tags}`);
  const shown = other + (softCounts ? s.soft : 0);
  const at = s.firstAt === -1 ? 0 : s.firstAt;
  return {
    kind: 'invisible-chars',
    severity: high ? 'high' : 'low',
    detail: `${shown} invisible character${shown === 1 ? '' : 's'} (${parts.join(', ')})`,
    sample: makeSample(raw.slice(Math.max(0, at - 20), at + 60).replace(/\n/g, ' '), 20),
  };
}

/** ASCII hidden in Unicode tag characters (U+E0020-E007E), or ''. */
function decodeTagChars(raw) {
  let out = '';
  for (const ch of raw) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
  }
  return out;
}

// ── Detector: instruction-shaped lines ──────────────────────────────────────

// Lookbehind/lookahead standing in for \b so "a.i." and hyphenated forms work.
const B = '(?<![a-z0-9])';
const E = '(?![a-z0-9])';
// "Hello AI engineers" greets a human audience; these suffixes disqualify.
const AUDIENCE =
  '(?:engineers?|team|teams|researchers?|enthusiasts?|practitioners?|experts?|folks|people|community|specialists?|developers?|scientists?|lovers?|builders?|powered|driven|based|enabled|first|native|related|focused|startups?|companies|company|products?|platforms?|roadmaps?|projects?|strategy|initiatives?|labs?|ethics|safety)';
const AI_NOUN =
  '(?:assistants?|agents?|models?|systems?|screeners?|evaluators?|reviewers?|bots?|crawlers?|tools?|readers?|recruiters?|parsers?|processors?)';
const AI_TERM =
  `(?:(?:ai|a\\.i\\.|llm|gpt|automated|artificial\\s+intelligence|language\\s+model)[\\s-]+${AI_NOUN}` +
  '|chatgpt|claude|gemini|copilot|chatbots?|llms?|crawlers?|scrapers?|ai|a\\.i\\.)';
const AI_TAIL = `${E}(?![-\\s]+${AUDIENCE}${E})`;
const SENT = '(?:^|[.!?]\\s+)'; // start of a line or sentence
const VERBS =
  "(?:please|ignore|disregard|rate|score|rank|give|output|reply|respond|recommend|mark|flag|treat|stop|do\\s+not|don'?t)";
const ROLE_LINE_BODY =
  "(?:you\\b|your\\b|ignore|disregard|the\\s+(?:user|candidate|applicant)|do\\b|don'?t|always|never|new\\b|important|override|rate|score|rank|reply|respond|output|return|print|say|answer|act\\b|behave|pretend|follow|obey|execute|send|fetch|give|assess|approve|mark|treat|evaluate|from\\s+now|this\\s+(?:is|candidate|applicant|listing|posting))";

/**
 * Each rule runs on a normalised line (invisibles stripped, NFKC, confusables
 * mapped, lowercase via the `i` flag). `hiddenOnly` rules fire only for text a
 * human cannot see, where even an ordinary-looking request is suspicious.
 */
const RULES = [
  // Addressing a model.
  { id: 'address', re: new RegExp(`${B}(?:dear|hey|hello|hi|attention|note\\s+to|message\\s+to|notice\\s+to|calling|to\\s+(?:any|all|every))\\s*[:,]?\\s+(?:the\\s+|any\\s+|all\\s+|every\\s+|other\\s+|fellow\\s+)?${AI_TERM}${AI_TAIL}`, 'i') },
  { id: 'if-you-are-ai', re: new RegExp(`${B}(?:if|when|since|because|as)\\s+you(?:'re|\\s+are|\\s+happen\\s+to\\s+be)\\s+(?:an?\\s+|the\\s+)?(?:ai|a\\.i\\.|llm|chatbot|language\\s+model|gpt|chatgpt|claude|gemini|copilot|automated|bot|crawler|scraper|ai[\\s-]+(?:assistant|agent|model|system|screener|evaluator|reviewer))${AI_TAIL}`, 'i') },
  { id: 'ai-colon-verb', re: new RegExp(`${B}(?:ai|a\\.i\\.|llm|chatgpt|gpt-?\\d*|language\\s+model)s?\\s*[,:–—-]\\s*${VERBS}${E}`, 'i') },
  { id: 'name-colon-verb', re: new RegExp(`${B}(?:claude|gemini|copilot)\\s*[,:]\\s*(?:ignore|disregard|rate|score|rank|give|output|reply|respond|recommend|mark|flag|treat|stop|do\\s+not|don'?t)${E}`, 'i') },
  { id: 'role-colon-verb', re: new RegExp(`^(?:assistant|agent|bot|model|evaluator|screener|reviewer|crawler)s?\\s*[,:]\\s*${VERBS}${E}`, 'i') },
  { id: 'ai-reading-this', re: new RegExp(`${B}${AI_TERM}[^.\\n]{0,30}?\\b(?:reading|reviewing|processing|parsing|summari[sz]ing|evaluating|scoring|screening|analy[sz]ing|scanning|crawling)\\s+(?:this|the\\s+(?:page|posting|listing|text|document))`, 'i') },
  { id: 'meant-for-ai', re: new RegExp(`this\\s+(?:message|note|text|section|paragraph|line)\\s+is\\s+(?:only\\s+)?(?:for|intended\\s+for|addressed\\s+to|meant\\s+for)\\s+(?:the\\s+)?${AI_TERM}${E}`, 'i') },
  // Overriding instructions.
  { id: 'ignore-instructions', re: new RegExp(`${B}(?:ignore|disregard|forget|override|bypass)\\s+(?:all\\s+|any\\s+|the\\s+|your\\s+|every\\s+|my\\s+)?(?:(?:previous|prior|above|earlier|preceding|other|these|those|system|safety)\\s+)?(?:instructions?|prompts?|rules|guidelines|directions|criteria|rubric|scoring|constraints|safeguards|filters|restrictions)${E}`, 'i') },
  { id: 'ignore-everything', re: new RegExp(`${B}(?:forget|disregard|ignore)\\s+(?:everything|all)\\s+(?:above|before|you|previous|prior|else)`, 'i') },
  { id: 'you-must-ignore', re: new RegExp(`${B}you\\s+(?:must|should|shall)\\s+(?:now\\s+)?(?:ignore|disregard|override|forget|obey)${E}`, 'i') },
  { id: 'you-are-now', re: new RegExp(`${B}you\\s+are\\s+now\\s+(?:an?\\s+)?(?:ai|assistant|agent|helpful|unrestricted|jailbroken|dan\\b|in\\s+(?:developer|debug|god|admin|maintenance)|acting|playing|operating|free\\b|my\\b|no\\s+longer)`, 'i') },
  { id: 'from-now-on', re: new RegExp(`${B}from\\s+now\\s+on,?\\s+you\\s+(?:will|must|are|should|shall|only|have\\s+to)\\s+(?:only\\s+)?(?:respond|reply|answer|act|behave|ignore|output|rate|score|rank|follow|obey|be\\s+(?:an?\\s+)?(?:ai|assistant|evil|unrestricted))`, 'i') },
  { id: 'pretend', re: new RegExp(`${B}pretend\\s+(?:to\\s+be|that\\s+you|you\\s+are)${E}`, 'i') },
  { id: 'jailbreak', re: new RegExp(`${B}(?:jailbreak|dan\\s+mode|do\\s+anything\\s+now)${E}`, 'i') },
  { id: 'system-prompt', re: new RegExp(`${B}(?:(?:reveal|print|show|repeat|output|leak|disclose|ignore|disregard|override|forget|bypass|replace|new|updated|following|above|your|the\\s+real)\\s+(?:the\\s+)?system\\s+(?:prompt|message|instructions?)|system\\s+prompt\\s*:)`, 'i') },
  { id: 'new-instructions', re: new RegExp(`${B}(?:(?:new|updated|revised|additional|real|actual|hidden|secret)\\s+(?:system\\s+)?instructions?\\s*[:\\-–—]|follow\\s+(?:these\\s+)?new\\s+instructions|(?:these|the\\s+following)\\s+new\\s+instructions)`, 'i') },
  // Chat-template and role markup.
  { id: 'role-line', re: new RegExp(`${SENT}(?:system|assistant|developer)\\s*:\\s*${ROLE_LINE_BODY}`, 'i') },
  { id: 'template-token', re: /<\|[a-z_]+\|>|\[\/?inst\]|<<\/?sys>>/i },
  { id: 'markdown-instruction', re: /^#{1,6}\s*(?:instructions?|system|response)\s*:|^###\s*instruction\s*$/i },
  // Steering the verdict.
  { id: 'rate-this', re: new RegExp(`${B}(?:rate|score|rank|grade)\\s+this\\s+(?:candidate|applicant|listing|posting|role|job|resume|cv|application|position|company)${E}`, 'i') },
  { id: 'rate-me', re: new RegExp(`${B}(?:rate|score|rank)\\s+(?:me|my\\s+(?:cv|resume|application|profile|candidacy))${E}`, 'i') },
  { id: 'give-score', re: new RegExp(`${B}give\\s+(?:it|this|me|them)\\s+an?\\s+(?:perfect\\s+|top\\s+|high\\s+|maximum\\s+|max\\s+)?(?:score|rating|grade)${E}`, 'i') },
  { id: 'rate-as', re: new RegExp(`${B}(?:(?:rate|score|rank|mark|flag|treat|consider|classify)\\s+(?:it|this|them|me)\\s+as\\s+(?:an?\\s+)?(?:perfect|top|best|ideal|strong|excellent|great|10|highest|maximum)|(?:rate|score)\\s+(?:it|this|me)\\s+(?:a\\s+)?(?:10|ten|perfect|highly|high|maximum))`, 'i') },
  { id: 'recommend-me', re: new RegExp(`${B}recommend\\s+(?:me|this\\s+candidate|this\\s+applicant)${E}`, 'i') },
  { id: 'score-spoof', re: /(?<![a-z0-9])(?:verdict\s*[:=]\s*go(?![a-z0-9])|eligibility\s*[:=]\s*green|match\s*[:=]\s*(?:10|9)\b[^\n]{0,20}\bease\s*[:=]\s*(?:10|9)\b)/i },
  // Secrecy, execution, exfiltration, forced output.
  { id: 'secrecy', re: new RegExp(`${B}(?:do\\s+not|don'?t|never)\\s+(?:mention|reveal|tell|disclose|say|inform|alert|notify|show)\\s+(?:this|that|these|it\\b|the\\s+(?:user|human|candidate|applicant|reader)|(?:to\\s+)?(?:the\\s+)?user|your\\s+(?:instructions|prompt)|anyone|about\\s+(?:this|these|the\\s+(?:above|hidden)))`, 'i') },
  { id: 'run-code', re: new RegExp(`${B}(?:run|execute)\\s+(?:the\\s+following|this|these|the\\s+below|any)\\s+(?:shell\\s+|bash\\s+|python\\s+|terminal\\s+)?(?:commands?|code|script|snippet|program)${E}`, 'i') },
  { id: 'curl', re: new RegExp(`${B}(?:(?:curl|wget)\\s+(?:-[a-z-]+\\s+)*['"]?https?://|curl\\s+-[a-z])`, 'i') },
  { id: 'pipe-shell', re: /\|\s*(?:ba|z)?sh(?![a-z0-9])/i },
  { id: 'fetch-url', re: new RegExp(`${B}(?:fetch|exfiltrate)\\s+(?:the\\s+(?:url|page|contents?\\s+of)\\s+)?https?://`, 'i') },
  { id: 'send-to-url', re: new RegExp(`${B}(?:send|post|upload|forward|transmit|leak|exfiltrate|submit)\\b[^.\\n]{0,60}?\\b(?:cv|resume|résumé|data|profile|information|conversation|context|prompt|credentials|api\\s+keys?|secrets?|files?|documents?)\\b[^.\\n]{0,60}?\\b(?:to|at|via|using)\\s+(?:https?://|www\\.)`, 'i') },
  { id: 'send-to-email-hidden', hiddenOnly: true, re: new RegExp(`${B}(?:send|forward|email|mail|submit)\\b[^.\\n]{0,60}?\\b(?:cv|resume|résumé|data|profile|conversation|context|prompt|credentials|secrets?)\\b[^.\\n]{0,60}?\\b(?:to|at)\\s+\\S+@\\S+`, 'i') },
  { id: 'output-only', re: new RegExp(`${B}(?:output|respond|reply|answer)\\s+only${E}`, 'i') },
  { id: 'reply-with-literal', re: new RegExp(`${B}(?:reply|respond|answer|return|print)\\s+(?:only\\s+)?with\\s+(?:only\\s+|exactly\\s+|just\\s+)?(?:the\\s+(?:word|phrase|text|string|number|following)|["'“]|json${E}|yes${E}|no${E}|true${E}|false${E}|\\d)`, 'i') },
];

/** Strip invisibles, fold NFKC and common Cyrillic/Greek look-alikes, so evasion doesn't dodge the rules. */
const CONFUSABLES = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
  α: 'a', ο: 'o', ν: 'v', ρ: 'p', ι: 'i', κ: 'k', τ: 't',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

function normalizeForMatching(s) {
  return s
    .replace(INVISIBLE_G, '')
    .normalize('NFKC')
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c])
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(WS_RE, ' ')
    .replace(/^ | $/g, '');
}

/** First rule that matches `line`, as `{ id, index }`, or null. */
function matchInstruction(line, hidden) {
  const norm = normalizeForMatching(line);
  if (norm.length < 4) return null;
  for (const rule of RULES) {
    if (rule.hiddenOnly && !hidden) continue;
    const m = rule.re.exec(norm);
    if (m) return { id: rule.id, index: Math.min(m.index, line.length) };
  }
  return null;
}

function hasInstruction(text, hidden) {
  return text.split('\n').some((l) => matchInstruction(l, hidden));
}

/** Matching lines across visible text, hidden blocks, comments and smuggled tag-character text. */
function instructionSignal(visibleText, doc, raw) {
  const sources = [{ text: visibleText, hidden: false }];
  for (const b of doc.hardBlocks) sources.push({ text: tidy(b.text), hidden: true });
  for (const c of doc.comments) sources.push({ text: tidy(c.replace(/<[^>]*>/g, ' ')), hidden: true });
  const smuggled = decodeTagChars(raw);
  if (smuggled) sources.push({ text: smuggled, hidden: true });
  const seen = new Set();
  const hits = [];
  for (const src of sources) {
    for (const line of src.text.split('\n')) {
      const key = `${src.hidden}:${line}`;
      if (!line || seen.has(key)) continue;
      seen.add(key);
      const hit = matchInstruction(line, src.hidden);
      if (hit) hits.push({ line, hidden: src.hidden, ...hit });
    }
  }
  if (!hits.length) return null;
  const hiddenHits = hits.filter((h) => h.hidden).length;
  const first = hits.find((h) => h.hidden) ?? hits[0];
  return {
    kind: 'instruction-shaped',
    severity: 'high',
    detail: `${hits.length} instruction-shaped line${hits.length === 1 ? '' : 's'}` +
      `${hiddenHits ? ` (${hiddenHits} in hidden text)` : ''}, first rule: ${first.id}`,
    sample: makeSample(first.line, first.index),
  };
}

// ── Detector: hidden-only URLs ──────────────────────────────────────────────

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`\])}]+/gi;

const extractUrls = (s) => (s.match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, ''));

/** Compare URLs without scheme, `www.`, fragment or trailing slash. */
const normUrl = (u) =>
  u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/#.*$/, '').replace(/\/+$/, '');

/**
 * The registrable part of a host, roughly: the last two labels, or three under
 * a two-letter country code with a generic second level (`example.co.uk`).
 */
export function siteOf(host) {
  const labels = String(host ?? '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const [sld, tld] = labels.slice(-2);
  const n = tld.length === 2 && /^(co|com|org|net|ac|gov|edu|ne|or)$/.test(sld) ? 3 : 2;
  return labels.slice(-n).join('.');
}

function hostOf(u) {
  try { return new URL(/^www\./i.test(u) ? `https://${u}` : u).hostname; } catch { return ''; }
}

/**
 * Links only hidden content carries. A hidden link to the page's own site
 * (a locale switcher, a collapsed menu) is navigation; a posting's injected
 * link points somewhere else, so only other sites count.
 */
function hiddenUrlSignal(items, doc, visibleText, pageUrl) {
  const hiddenUrls = [];
  for (const it of items) {
    if (it.source === 'aria-hidden') continue; // still rendered
    hiddenUrls.push(...extractUrls(it.text), ...it.hrefs.filter((h) => /^(?:https?:\/\/|www\.)/i.test(h)));
  }
  // Hrefs of hidden elements that carried no reportable text still count.
  for (const b of doc.hardBlocks) {
    for (const h of b.hrefs) if (/^(?:https?:\/\/|www\.)/i.test(h)) hiddenUrls.push(h);
  }
  if (!hiddenUrls.length) return null;
  const visibleBlob = [visibleText, ...doc.visibleHrefs]
    .join('\n')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/www\./g, '');
  const only = [];
  const ownSite = pageUrl ? siteOf(hostOf(pageUrl)) : '';
  for (const u of hiddenUrls) {
    const n = normUrl(u);
    if (ownSite && siteOf(hostOf(u)) === ownSite) continue;
    if (n && !visibleBlob.includes(n) && !only.includes(u)) only.push(u);
  }
  if (!only.length) return null;
  return {
    kind: 'hidden-only-url',
    severity: 'high',
    detail: `${only.length} link${only.length === 1 ? '' : 's'} present only in hidden content`,
    sample: makeSample(only[0]),
  };
}

// ── Detector: mixed-script words ────────────────────────────────────────────

function mixedScriptSignal(raw) {
  const bad = [];
  for (const w of raw.match(/[\p{L}\p{M}]{3,}/gu) || []) {
    if (/\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w)) bad.push(w);
  }
  if (!bad.length) return null;
  return {
    kind: 'mixed-script',
    severity: bad.length >= 3 ? 'high' : 'low',
    detail: `${bad.length} word${bad.length === 1 ? '' : 's'} mixing Latin with Cyrillic/Greek letters`,
    sample: makeSample(bad.slice(0, 3).join(' ')),
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Parse whichever input is given (html preferred) into the shared extraction shape. */
function extractDoc({ html, text } = {}) {
  const useHtml = typeof html === 'string' && html.trim() !== '';
  return useHtml ? extractFromHtml(html.replace(/^\uFEFF/, '')) : extractFromText(text);
}

/**
 * The text a human reader sees: hidden elements, comments, scripts, styles and
 * templates removed, entities decoded, one block per line. Same input rules as
 * `analyzePosting`.
 *
 * @param {{ html?: string, text?: string }} input
 * @returns {string}
 */
export function extractVisibleText(input = {}) {
  return tidy(extractDoc(input).visible.join(''));
}

// ── The readable posting (what a worker is given instead of the raw page) ───

/** Every schema.org JobPosting node in the page's JSON-LD blocks. */
function jobPostingNodes(html) {
  const out = [];
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    const type = [].concat(node['@type'] ?? []);
    if (type.includes('JobPosting')) out.push(node);
    if (node['@graph']) visit(node['@graph']);
  };
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html ?? '').matchAll(re)) {
    try { visit(JSON.parse(m[1])); } catch { /* malformed block: skip */ }
  }
  return out;
}

/** A JSON-LD description as text; some ATSs entity-escape its HTML, so decode twice when tags survive. */
function descriptionText(html) {
  const once = extractVisibleText({ html });
  return /<\/?[a-z][^>]*>/i.test(once) ? extractVisibleText({ html: once }) : once;
}

/**
 * The job text a page's JSON-LD carries (title, employer, place, description
 * as plain text), or '' when it has none. Client-rendered ATS pages (Ashby,
 * some careers sites) have almost no visible text but a full JobPosting here.
 */
export function jobPostingText(html) {
  const parts = [];
  for (const n of jobPostingNodes(html)) {
    const place = [].concat(n.jobLocation ?? []).map((l) => {
      const a = l?.address ?? {};
      return [a.addressLocality, a.addressRegion, a.addressCountry?.name ?? a.addressCountry].filter((x) => typeof x === 'string').join(', ');
    }).filter(Boolean).join(' · ');
    const lines = [
      typeof n.title === 'string' ? `Title: ${n.title}` : '',
      typeof n.hiringOrganization?.name === 'string' ? `Employer: ${n.hiringOrganization.name}` : '',
      place ? `Location: ${place}` : '',
      n.employmentType ? `Employment: ${[].concat(n.employmentType).join(', ')}` : '',
      typeof n.description === 'string' ? descriptionText(n.description) : '',
    ].filter(Boolean);
    if (lines.length) parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * The posting as a person reads it: the JSON-LD job text, then the page's
 * visible text, with hidden elements, comments and scripts already gone. A
 * worker that reads this never sees hidden text at all.
 */
export function readablePosting({ html, text } = {}) {
  if (!html) return tidy(String(text ?? ''));
  return [jobPostingText(html), extractVisibleText({ html })].filter((t) => t.trim()).join('\n\n---\n\n');
}

/**
 * Analyse a posting for injection tricks. Give `html` (preferred: hidden-text
 * detection needs it) and/or `text` (already-visible text; nothing can be
 * hidden in it).
 *
 * @param {{ html?: string, text?: string, pageUrl?: string }} input  pageUrl: where the page came from (same-site hidden links are navigation)
 * @returns {{
 *   verdict: 'clean'|'caution'|'suspect',
 *   signals: Array<{ kind: string, severity: 'low'|'high', detail: string, sample: string }>,
 *   visibleText: string,
 * }}
 */
export function analyzePosting({ html, text, pageUrl } = {}) {
  const doc = extractDoc({ html, text });
  const visibleText = tidy(doc.visible.join(''));
  const items = collectHiddenItems(doc);
  // Everything a model could read, for the character-level detectors.
  const raw = [doc.visible.join(''), ...doc.hardBlocks.map((b) => b.text), ...doc.comments].join('\n');

  const signals = [
    hiddenHtmlSignal(items),
    invisibleCharsSignal(raw),
    instructionSignal(visibleText, doc, raw),
    hiddenUrlSignal(items, doc, visibleText, pageUrl),
    mixedScriptSignal(raw),
  ].filter(Boolean);

  const verdict = !signals.length ? 'clean' : signals.some((s) => s.severity === 'high') ? 'suspect' : 'caution';
  return { verdict, signals, visibleText };
}

const KIND_LABELS = {
  'hidden-html': 'hidden text',
  'invisible-chars': 'invisible characters',
  'instruction-shaped': 'instruction-shaped lines',
  'hidden-only-url': 'hidden-only links',
  'mixed-script': 'mixed-script words',
};

/**
 * The value for the report header: `clean`, or `<verdict> — <labels>` with
 * the labels of the distinct signal kinds joined by ", ".
 *
 * @param {{ verdict: string, signals: Array<{ kind: string }> }} result
 * @returns {string}
 */
export function formatVerdictLine(result) {
  const kinds = [...new Set((result.signals ?? []).map((s) => s.kind))];
  if (!kinds.length) return result.verdict;
  return `${result.verdict} — ${kinds.map((k) => KIND_LABELS[k] ?? k).join(', ')}`;
}
