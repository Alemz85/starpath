/**
 * learn-core.mjs — the gate between a session retro and the user's files.
 *
 * At the end of a session the `retro` mode (modes/retro.md) may propose up to
 * five rule candidates: things the agent learned about how this user wants the
 * work done. Each is `{ kind, change, evidence: { source, quote } }`. This
 * module decides which of them may even be shown to the user, numbers the
 * survivors into a pending file, and renders the lines `learn.mjs apply`
 * writes once the user names the ids they accept.
 *
 * The gate is deterministic and fails closed. It throws out:
 *   - anything that touches the safety contract (submitting or sending without
 *     review, skipping a confirmation): those rules are fixed in CLAUDE.md and
 *     are not learnable;
 *   - anything that could steer a later agent outside the user's preferences:
 *     URLs (also split or spelled out), shell or command text, role headers and
 *     "ignore previous instructions" lines, references to system files or to
 *     any file at all;
 *   - factual claims about the person (employers, degrees, dates, metrics,
 *     skill or language levels): facts live in user/career-bank.md and
 *     user/cv.md and go through the CV path, never through a retro;
 *   - evidence that is not the user's own words in the session. A job posting,
 *     a fetched page or a search result is untrusted text written by strangers
 *     (modes/_shared.md § Untrusted content), and a quote that reads like
 *     pasted posting text is refused even when it is labelled as the user's.
 *
 * Every accepted rule lands in user/_profile.md under `## Learned preferences`,
 * in the subsection of its kind. Nothing is written to user/profile.yml: its
 * values are read by the deterministic scorer and the eligibility gate, a
 * one-sentence preference has no safe structured slot there, and rewriting the
 * user's hand-commented YAML would drop their comments. Structured changes go
 * through `calibrate`, which suggests the edit and leaves it to the user.
 *
 * Pure (no I/O); unit-tested in learn-core.test.mjs. The CLI is
 * scripts/learn.mjs.
 */

import { createHash } from 'node:crypto'

export const MAX_CANDIDATES = 5
export const TARGET_FILE = 'user/_profile.md'
export const PENDING_FILE = 'data/learn-pending.json'
export const LEDGER_FILE = 'data/learn-ledger.tsv'
export const SECTION_HEADING = '## Learned preferences'
export const SECTION_INTRO = '<!-- Added by the retro gate after you accepted each rule by id. Edit or delete lines freely. -->'
export const LEDGER_COLUMNS = ['date', 'id', 'action', 'kind', 'target', 'hash', 'summary']
export const CHANGE_LIMITS = { min: 10, max: 280 }
export const QUOTE_LIMITS = { min: 3, max: 280 }

/**
 * The kinds a rule may have, and the subsection of `## Learned preferences`
 * in user/_profile.md each one lands in. All are narrative guidance an agent
 * reads; none changes a number the scorer uses.
 */
export const KINDS = {
  tone: { section: 'Tone and writing', about: 'how drafts, messages and replies should sound' },
  workflow: { section: 'Working style', about: 'how the agent should work with the user in a session' },
  scoring: { section: 'Scoring nuances', about: 'how to read a kind of listing; weights and calibration stay in user/profile.yml' },
  negotiation: { section: 'Negotiation stance', about: 'how to approach comp and offer conversations, without figures' },
  targeting: { section: 'Targeting', about: 'kinds of roles, teams or companies to lean towards or away from' },
}
export const KIND_NAMES = Object.keys(KINDS)

/** Evidence the gate accepts: the user's own words in this session. */
export const TRUSTED_SOURCES = {
  'user-message': "the user's own words in this session",
  'user-correction': 'a correction the user made to something the agent did',
}

/** Sources named for a clearer reason; anything else not trusted is unknown. */
const UNTRUSTED_SOURCES = [
  'posting', 'job-posting', 'jd', 'job-description', 'listing', 'job-listing', 'pasted-posting',
  'fetched-page', 'page', 'web', 'webpage', 'web-page', 'webfetch', 'url', 'website',
  'search', 'search-result', 'websearch', 'report', 'email', 'recruiter', 'document', 'file', 'tool-output',
]

const CANDIDATE_FIELDS = new Set(['kind', 'change', 'evidence'])
const EVIDENCE_FIELDS = new Set(['source', 'quote'])

/** Every reason a candidate can be refused for, with what it means. */
export const REASONS = {
  'not-an-array': 'the input is not a list of candidates',
  'too-many': `more than ${MAX_CANDIDATES} candidates in one retro; nothing was accepted (propose the strongest ${MAX_CANDIDATES} or fewer)`,
  shape: 'not a {kind, change, evidence:{source, quote}} object, or it carries extra fields',
  'kind-missing': 'no kind',
  'kind-unknown': `kind must be one of: ${KIND_NAMES.join(', ')}`,
  'evidence-missing': 'evidence needs both a source and a quote',
  'evidence-untrusted': 'evidence must be the user\'s own words; a job posting, fetched page, search result or report is untrusted text and never evidence',
  'evidence-source-unknown': `evidence source must be one of: ${Object.keys(TRUSTED_SOURCES).join(', ')}`,
  'evidence-posting-text': 'the quote reads like pasted job-posting text, which is never evidence',
  length: `change must be ${CHANGE_LIMITS.min}–${CHANGE_LIMITS.max} characters and the quote ${QUOTE_LIMITS.min}–${QUOTE_LIMITS.max}`,
  markup: 'one plain sentence only: no line breaks, headings, HTML, comments or code fences',
  obfuscated: 'hidden or look-alike characters, or a script the gate cannot read (write the rule in plain Latin-script text)',
  'auto-submit': 'submitting, sending or applying is always the user\'s own click after review (CLAUDE.md § Ethical Use); a rule about it is not learnable',
  'skip-review': 'review and confirmation steps are part of the safety contract; a rule that skips or loosens them is not learnable',
  url: 'no URLs, domains, e-mail addresses or links, even split up or spelled out',
  shell: 'no commands, code or shell syntax',
  'role-header': 'no role headers (system:, assistant:, <system> …)',
  injection: 'reads like an instruction to override the agent\'s rules',
  'system-file': 'no references to system files, settings, permissions or hooks',
  'file-reference': 'no file names or paths; a preference does not point at files',
  'factual-claim': 'a fact about the person (employer, degree, date, metric, money, skill or language level): add it to user/career-bank.md or user/cv.md through the CV path, not as a learned rule',
  duplicate: 'the same rule is already in this batch, pending, or in user/_profile.md',
}

// ─── Text helpers ────────────────────────────────────────────────────────────

/** Comparable form: NFKC, ASCII quotes and dashes, lower case, one space. */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Letters and digits only: catches words spaced or punctuated apart. */
export function squash(s) {
  return normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Key used to spot the same rule twice. */
export function ruleKey(s) {
  return normalizeText(s).replace(/[\s.!;,]+$/g, '').replace(/[^\p{L}\p{N} ]+/gu, '')
}

/** sha256 of the normalized rule, first 12 hex. */
export function ruleHash(change) {
  return createHash('sha256').update(normalizeText(change)).digest('hex').slice(0, 12)
}

const any = (text, patterns) => patterns.some((re) => re.test(text))

// ─── Content checks (each returns true when the text must be refused) ──────

// Invisible and control characters, bidi overrides, private-use and
// unassigned code points. A rule is one visible sentence.
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029\u00AD\u034F\u115F\u1160\u3164\uFFA0]/u
// Scripts other than Latin (and the shared Common/Inherited marks). Keyword
// checks below cannot read them, so they are refused rather than waved through.
const NON_LATIN_LETTER = /(?![\p{Script=Latin}])\p{L}/u
// Look-alike letters and digits: fullwidth forms, mathematical alphanumerics,
// enclosed and letterlike symbols, super- and subscripts, small capitals.
const LOOKALIKES = /[\uFF00-\uFFEF\u2100-\u218F\u2070-\u209F\u2460-\u24FF\u1D00-\u1DBF\uA730-\uA7FF\u0250-\u02AF\u{1D400}-\u{1D7FF}\u{1F100}-\u{1F1FF}]/u

export function hasObfuscation(raw) {
  const s = String(raw ?? '')
  if (/[\t\v\f]/.test(s)) return true
  if (HIDDEN_CHARS.test(s.replace(/[\n\r]/g, ''))) return true
  if (LOOKALIKES.test(s)) return true
  if (NON_LATIN_LETTER.test(s.normalize('NFKC'))) return true
  return false
}

export function hasMarkup(raw) {
  const s = String(raw ?? '')
  return /[\r\n]/.test(s)
    || /(^|\s)#{1,6}\s/.test(s)
    || /<\s*\/?\s*[a-z!?][^>]*>/i.test(s)
    || /<!--|-->/.test(s)
    || /```|~~~/.test(s)
    || /^\s*([-*+>]|\d+[.)])\s/.test(s)
    || /\[[^\]]*\]\([^)]*\)/.test(s)
}

// What sending an application looks like, in the languages the gate reads.
const SUBMIT_VERB = new RegExp('\\b(' + [
  'submit\\w*', 'send\\w*', 'sent', 're-?send\\w*', 'apply(ing)?\\s+(to|for)\\b', 'applies\\s+(to|for)\\b', 'applied\\s+(to|for)\\b',
  'applications?', 'publish\\w*', 'post(ing|ed)?\\s+(it|them|this|that|the|my|on|to)\\b', 'mail\\s+(it|them)', 'e-?mail\\s+(it|them|the|recruiters?)',
  'reply\\s+to\\s+(the\\s+)?recruiters?', 'dispatch\\w*', 'fire\\s+(\\w+\\s+)?off', 'outreach\\s+messages?', 'ship\\s+(it|them)', 'message\\s+(the\\s+)?(recruiters?|contacts?|hiring)',
  // es / pt / it / fr / de / da / nl, the common forms only
  'enviar\\w*', 'env[ií]a\\w*', 'env[ií]e\\w*', 'mandar\\w*', 'postular\\w*', 'postula', 'postule\\w*', 'aplicar\\w*', 'solicitar\\w*', 'submeter\\w*', 'candidatar\\w*', 'candidatura\\w*',
  'inviare', 'invia', 'invii', 'inoltrar\\w*', 'inoltra', 'candidarsi', 'candidati',
  'envoyer', 'envoie\\w*', 'envoyez', 'soumettre', 'soumets', 'soumettez', 'postuler', 'postulez',
  'senden', 'sendet', 'absenden', 'abschicken', 'schicken', 'schick', 'schickt', 'bewerbung\\w*', 'einreichen', 'bewerben', 'bewirb\\w*',
  'sende', 'indsend\\w*', 'ans[øo]g\\w*', 'ansoeg\\w*', 's[øo]ge',
  'versturen', 'verstuur', 'verzenden', 'verzend', 'indienen', 'solliciteren', 'sturen', 'stuur',
].join('|') + ')\\b')

// What makes it unattended: automation, no review, on the user's behalf.
const UNATTENDED = new RegExp('(' + [
  '\\bauto\\w*', '\\bwithout\\b', '\\bon\\s+my\\s+behalf\\b', '\\bfor\\s+me\\b', '\\bmyself\\b', '\\byourself\\b', '\\bby\\s+itself\\b',
  '\\bimmediately\\b', '\\bdirectly\\b', '\\bright\\s+away\\b', '\\bstraight\\s+away\\b', '\\binstantly\\b', '\\bas\\s+soon\\s+as\\b',
  '\\bno\\s+need\\b', '\\bdon\'?t\\s+(ask|wait|check)', '\\bdo\\s+not\\s+(ask|wait|check)', '\\bnever\\s+(ask|wait|check)',
  '\\breview\\w*', '\\bconfirm\\w*', '\\bapprov\\w*', '\\bpermission\\b', '\\bsign-?\\s?off\\b', '\\bask(ing)?\\b', '\\bcheck(ing)?\\s+with\\b',
  '\\bgo-?\\s?ahead\\b', '\\bwhen(ever)?\\s+(it|a|the)\\b.*\\b(scores?|passes|clears|reaches|hits|looks)\\b', '\\bif\\s+(it|the\\s+\\w+)\\s+(scores?|passes|clears|reaches|hits|looks)\\b',
  '\\bbulk\\b', '\\bmass\\b', '\\bone-?\\s?click\\b', '\\bunattended\\b', '\\bovernight\\b', '\\bin\\s+the\\s+background\\b',
  // es / pt / it / fr / de / da / nl
  '\\bsin\\b', '\\bsem\\b', '\\bsenza\\b', '\\bsans\\b', '\\bohne\\b', '\\buden\\b', '\\bzonder\\b',
  'autom[aá]t\\w*', 'automatisch\\w*', 'automatisk\\w*', 'automatique\\w*',
  '\\brevisar\\w*', '\\brevis[ãa]o\\b', '\\brevisi[óo]n\\b', '\\brivedere\\b', '\\brevisione\\b', '\\brelire\\b', '\\brevoir\\b', '\\bv[ée]rifier\\b',
  '\\b[üu]berpr[üu]f\\w*', '\\bpr[üu]fen\\b', '\\bpr[üu]fung\\w*', '\\bgennemse\\w*', '\\bcontroleren\\b',
  '\\bconfirmar\\b', '\\bconfermar\\w*', '\\bconferma\\b', '\\bconfirmer\\b', '\\bbest[äa]tig\\w*', '\\bbekr[æa]ft\\w*', '\\bbevestig\\w*',
  '\\bpreguntar\\w*', '\\bperguntar\\w*', '\\bchiedere\\b', '\\bdemander\\b', '\\bfragen\\b', '\\bsp[øo]rge\\b', '\\bvragen\\b',
].join('|') + ')')

const AUTO_SUBMIT_DIRECT = [
  /\bauto-?\s?(submit|send|apply|post|reply|respond|fill|complete|click|approve)\w*/,
  /\b(one|single)-?\s?click\s+appl/,
  /\b(mass|bulk|batch)[-\s]?(apply|applying|application|send|submit)/,
  /\bappl(y|ying)\s+(to|for)\s+(all|every|each|everything|anything|any)\b/,
  /\b(send|submit)\w*\s+(them\s+|it\s+|these\s+)?(all|every|each|everything)\b/,
  /\b(click|press|hit|tap)\w*\s+(the\s+)?(submit|send|apply|post|confirm)\b/,
]

export function isAutoSubmit(norm) {
  if (any(norm, AUTO_SUBMIT_DIRECT)) return true
  const sq = norm.replace(/[^\p{L}\p{N}]+/gu, '')
  if (/auto(submit|send|apply|reply|approve)|submitwithout|sendwithout|applywithout|sendforme|submitforme|applyforme/.test(sq)) return true
  return SUBMIT_VERB.test(norm) && UNATTENDED.test(norm)
}

const REVIEW_WORD = '(review\\w*|confirm\\w*|approv\\w*|sign-?\\s?off|check(ing)?\\s+with\\s+me|ask(ing)?(\\s+me)?|wait(ing)?\\s+for\\s+me|human|my\\s+(ok|okay|go-?\\s?ahead)|proofread\\w*|look(ing)?\\s+(at|over)\\s+it|double-?\\s?check\\w*|safeguards?|guardrails?|gates?|checks?|stop(ping)?\\s+before)'
const LOOSEN_WORD = '(skip\\w*|bypass\\w*|omit\\w*|drop\\w*|disabl\\w*|turn\\w*\\s+off|ignor\\w*|remov\\w*|no\\s+longer|stop\\w*|don\'?t|do\\s+not|never|no\\s+need|without|no\\s+more|less|fewer|relax\\w*|loosen\\w*|waiv\\w*|forgo\\w*|avoid\\w*|cut\\w*|not\\s+necessary|unnecessary|optional)'
const SKIP_REVIEW = [
  new RegExp(`\\b${LOOSEN_WORD}\\b(\\W+\\w+){0,5}?\\W+${REVIEW_WORD}`),
  new RegExp(`\\b${REVIEW_WORD}\\b(\\W+\\w+){0,4}?\\W+(is|are|isn't|aren't)\\s+(not\\s+)?(needed|required|necessary|optional|unnecessary|overkill)`),
  /\b(trust|assume)\s+(that\s+)?(the|my|your)?\s*(drafts?|answers?|outputs?|forms?|letters?|it|them)\b.*\b(fine|good|correct|ok|okay|ready|final|done)\b/,
  /\b(approval|confirmation|ok|okay|consent|go-?\s?ahead|sign-?\s?off)\s+(as\s+)?(given|granted|implied|assumed|implicit|a\s+default|the\s+default)\b/,
  /\b(assume|consider|treat|take)\s+(my\s+)?(approval|consent|ok|okay|confirmation|silence)\b/,
  /\bready\s+to\s+(go|send|submit|ship)\b|\bgood\s+to\s+(go|send|submit)\b|\bfire\s+(it|them)\s+off\b/,
  /\b(saltar|omitir|ignorar|sauter|ignorer|saltare|ignorare|überspring\w*|ueberspring\w*|spring\w*\s+over|overslaan|pular)\b/,
  /\b(salt\w*|omit\w*|ignor\w*|saute\w*|spring\w*|sla\w*\s+over|pul\w*|sin|sem|senza|sans|ohne|uden|zonder)\b.*\b(revis\w*|rived\w*|relir\w*|relecture|v[ée]rifi\w*|pr[üu]f\w*|controle\w*|gennems\w*|confirm\w*|conferm\w*|best[äa]tig\w*|bekr[æa]ft\w*|bevestig\w*)/,
]

export function isSkipReview(norm) {
  const sq = norm.replace(/[^\p{L}\p{N}]+/gu, '')
  if (/skip(the)?(review|confirm|check)|noreview|noconfirm|withoutreview|withoutconfirm|withoutasking|dontask|donotask|neverask/.test(sq)) return true
  return any(norm, SKIP_REVIEW)
}

const TLD = '(com|net|org|io|ai|dev|co|app|me|xyz|info|biz|gg|ly|sh|so|to|uk|de|fr|es|it|nl|dk|se|no|ch|eu|us|ca|jobs|careers|link|site|online|tech|cloud|page|run|zip|mov|tk|ru|cn|in|ws|cc|tv|fm|pro|work|email|live|life|world|top|club|icu|vip|shop|store)'
const URL_PATTERNS = [
  /\b[a-z][a-z0-9+.-]*:\/\//,
  /\b(https?|hxxps?|ftp|sftp|file|mailto|javascript|data|vbscript|tel|sms|ws|wss)\s*:/,
  /\bwww\s*\./, /\bw\s*w\s*w\s*(\.|\bdot\b)/,
  new RegExp(`\\b[a-z0-9-]{2,}\\s*(\\.|\\[\\.\\]|\\(\\.\\)|\\{\\.\\}|\\[dot\\]|\\(dot\\)|\\{dot\\}|\\bdot\\b|\\bpunto\\b|\\bpunkt\\b|\\bpoint\\b)\\s*${TLD}(?![\\w-])`),
  /\b\d{1,3}(\s*\.\s*\d{1,3}){3}\b/,
  /[\w.+-]+\s*(@|\[at\]|\(at\)|\{at\})\s*[\w-]+\s*(\.|\bdot\b)\s*\w+/,
  /\/\/[a-z0-9]/, /\bslash\s+slash\b/, /\bcolon\s+slash/,
  /\b(bit\.ly|tinyurl|t\.co|goo\.gl)\b/,
  /\b(link|url|website|site|page|domain|href)\s*(:|=|is\b|at\b)/,
  /\bvisit\s+[a-z0-9-]+\s*(\.|\bdot\b)/,
]

export function hasUrl(norm) {
  if (any(norm, URL_PATTERNS)) return true
  const sq = norm.replace(/[^\p{L}\p{N}]+/gu, '')
  return /https?w{0,3}|hxxp|www[a-z0-9]{2,}(com|net|org|io)/.test(sq)
}

const SHELL_PATTERNS = [
  /`/,
  /\$\(|\$\{|\$[a-z_]{2,}\b|\$\d/,
  /\|\s*(sh|bash|zsh|fish|dash|node|python\d?|perl|ruby|php|sudo|tee|xargs|osascript|powershell|pwsh|iex)\b/,
  /&&|\|\||;\s*[a-z]+\s+-/,
  />>|\d>&\d|&>|(^|\s)>\s*[~/.$]|<<\s*['"]?[a-z]/,
  /\b(curl|wget|sudo|chmod|chown|chgrp|rmdir|mkfifo|netcat|ncat|ssh|scp|sftp|rsync|osascript|powershell|pwsh|launchctl|crontab|killall|pkill|dd|mkfs|base64|xxd|openssl|telnet|nohup|bash|zsh)\b/,
  /\brm\s+(-|\/|~|\*|\.)/, /\bkill\s+-/, /\bmv\s+\S+\s+\S/, /\bcp\s+-?\S+\s+\S/,
  /\b(eval|exec|system|spawn|popen|require|import)\s*\(/,
  /\b(npx|pnpm|yarn|deno|brew|docker|kubectl|pip3?|cargo|npm)\b/,
  /\b(node|npm|npx|pnpm|yarn|bun|deno|python\d?|pip\d?|ruby|perl|php|git|gh|brew|make|docker|claude|cargo|go)\s+(-|\.|\/|~|run\b|install\b|i\b|exec\b|add\b|push\b|commit\b|reset\b|clone\b|checkout\b|rebase\b|config\b|scripts\b|update\b|uninstall\b|remove\b|publish\b|plugin\b|mcp\b|--)/,
  /\b(node|python\d?|bash|sh|zsh|deno|bun)\s+[\w./-]+\.(m?js|cjs|ts|py|sh)\b/,
  /\bclaude\s+-p\b/, /--[a-z][a-z-]{2,}/,
  /\bshell\s*(command|script)\b|\bterminal\s+command\b|\bcommand\s+line\b|\brun\s+(this|the following|a)\s+(command|script)\b/,
]

export function hasShell(norm) {
  return any(norm, SHELL_PATTERNS)
}

const ROLE_HEADER = [
  /(^|[\s"'(\[{<>*_#|=-])(system|assistant|user|human|developer|tool|ai|claude|model|bot|operator|admin|root|instructions?)\s*:/,
  /<\s*\/?\s*(system|assistant|user|human|developer|tool|instructions?|im_start|im_end|s|inst)\b/,
  /\[\s*\/?\s*(inst|system|sys|assistant|user)\s*\]/,
  /<\|/, /\|>/,
  /\b(begin|end)\s+(system|instructions?|prompt)\b/,
]

export function hasRoleHeader(norm) {
  return any(norm, ROLE_HEADER)
}

const INJECTION = [
  /\b(ignore|disregard|forget|override|overrule|bypass|discard|drop|abandon|replace|cancel|nullify|supersede)\w*\b(\W+\w+){0,4}?\W+(previous|prior|above|earlier|preceding|existing|other|original|initial|all|any|your|the|every|these)\b(\W+\w+){0,3}?\W+(instructions?|rules?|prompts?|messages?|guidance|directions?|guidelines?|policies|policy|constraints?|contract|context|safeguards?|guardrails?|restrictions?)\b/,
  /\b(ignore|disregard|forget|override|bypass)\s+(everything|all\s+of\s+(that|this|it))\b/,
  /\byou\s+are\s+(now|no\s+longer|free|allowed|permitted|authori[sz]ed)\b/,
  /\b(pretend|act|behave|roleplay|role-play)\s+(to\s+be|as|like|you('re|\s+are))\b/,
  /\bnew\s+(system\s+)?(instructions?|rules|prompt|persona|role)\b/,
  /\bsystem\s+(prompt|message|instructions?|override)\b/,
  /\b(jailbreak|prompt\s+injection|dan\s+mode|developer\s+mode|god\s+mode|sudo\s+mode|unrestricted|uncensored)\b/,
  /\b(takes?|has|have|with)\s+(precedence|priority)\s+over\b/, /\b(highest|top|absolute)\s+priority\b/,
  /\b(supersedes?|overrides?|overrules?|outranks?)\b/,
  /\b(these|this|my|the\s+following)\s+(rules?|instructions?)\s+(win|wins|come\s+first|override)/,
  /\bdo\s+anything\s+now\b/, /\bno\s+(rules|restrictions|limits|filters)\b/,
  /\b(reveal|print|show|output|repeat|leak)\w*\s+(your|the)\s+(system\s+)?(prompt|instructions|rules|secrets?|keys?|tokens?|credentials?)\b/,
  /\b(api|access|secret|auth|bearer|oauth)\s*[-_]?\s*(key|token)s?\b|\bpasswords?\b|\bpasscodes?\b/,
]

export function hasInjection(norm) {
  return any(norm, INJECTION)
}

const SYSTEM_FILES = [
  /\bclaude\s*\.?\s*md\b/, /\bagents\s*\.?\s*md\b/, /\bclaude\s+code\b/,
  /\b(modes?|scripts?|batch|templates?|frontend|config|docs|\.claude|\.githooks?|\.git|private|demo|node_modules|electron)\s*\//,
  /(^|\W)\.claude\b/, /\.githooks?\b/, /\.gitignore\b/, /(^|\W)\.git\b/,
  /\bsettings\b/, /\bsetting\s+(file|json|page|panel)\b/, /\bpermission(s|ed)?\b/, /\b(allowed|disallowed)\s*-?\s*tools\b/,
  /\bdangerously\b/, /\bskip-permissions\b/, /\bdontask\b|\bdont-ask\b|\baccept-?edits\b|\bbypass\s*permissions\b/,
  /\b(git|pre-?commit|pre-?push|commit-?msg|session-?start|claude|tool|post-?tool|stop)\s*-?\s*hooks?\b/, /\bhooks?\s*(file|config|script|folder|directory)\b/,
  /\bcapabilit(y|ies)\b/, /\bworkers?\s*(kinds?|capabilit\w*|table|flags?)\b/,
  /\bpackage\s*\.?\s*json\b/, /\bdata[_\s-]contract\b/, /\brepo[_\s-]guide\b/, /\b_shared\b/, /\bbatch[_\s-]prompt\b/,
  /\bmode\s+files?\b/, /\bsystem\s+(files?|layer|prompts?)\b/, /\bprompt\s+files?\b/, /\bthe\s+(router|skill\s+file|leak\s+gate|retro\s+gate|gate)\b/,
  /\bleak[\s-]?(gate|check|terms?)\b/, /\bno-?verify\b/, /\bmcp\b/, /\b(environment|env)\s+var(iable)?s?\b/,
  /\boverrides?\s*\//, /\bprivate\s+overrides?\b/,
]

export function hasSystemFile(norm) {
  return any(norm, SYSTEM_FILES)
}

const FILE_REFERENCE = [
  /\b[\w-]+\.(md|mdx|mjs|cjs|js|jsx|ts|tsx|json|jsonl|ya?ml|toml|tsv|csv|sh|bash|zsh|py|rb|txt|html?|plist|env|ini|cfg|conf|lock|log|bak|pdf|docx?)\b/,
  /(^|[\s"'(])(\/|~\/|\.{1,2}\/)[\w.-]/,
  /\b(user|data|reports|output|jds|interview-prep|profiles|chat|docs|applications)\/([\w.-]+\.\w+|\*|tier-\d|$)/,
  /\b[a-z]:\\/,
  /\b(path|folder|directory|file)\s*(:|=)/,
]

export function hasFileReference(norm) {
  return any(norm, FILE_REFERENCE)
}

// Facts about the person. Preferences ("I prefer", "I want", "I don't like")
// pass; statements of record ("I worked at", "my GPA", "fluent in", a year, a
// percentage, a salary) are refused and pointed at the CV path.
const PERSON = '(i|i\'m|i\'ve|i\'d|me|my|mine|myself|the\\s+(user|candidate|applicant)|he|she|his|her)'
// "I have a strong preference…", "I'm a big fan of…" are preferences, not facts.
const NOT_A_FACT = '(?!\\s+(strong\\s+|slight\\s+|clear\\s+|real\\s+|big\\s+|huge\\s+|bit\\s+of\\s+a\\s+)?(preference|dislike|aversion|soft\\s+spot|bias|habit|tendency|rule|hard\\s+time|feeling|sense|problem|issue|thing|fan|stickler|believer|sucker|night\\s+owl|morning\\s+person|type|kind|sort|fan|lot\\s+of\\s+opinions|limited\\s+attention)\\b)'
const OWNS = '(my|his|her|i\\s+have|i\'ve|i\\s+had|i\\s+hold|i\\s+held|i\\s+earned|i\\s+got|i\\s+completed|i\\s+finished|i\'m\\s+(doing|finishing|completing|starting)|i\\s+am\\s+(doing|finishing|completing|starting)|the\\s+(user|candidate)\\s+(has|holds|had))'
const FACTUAL = [
  // First person, statement of record.
  new RegExp(`\\bi(\\s+have|\\s+had|'ve|'d)\\s+((a|an|the)\\b${NOT_A_FACT}|\\d|over\\b|more\\s+than|less\\s+than|nearly|almost|about\\s+\\d|around\\s+\\d|several\\b|many\\s+years|(two|three|four|five|six|seven|eight|nine|ten)\\b|years?\\b|months?\\b|experience\\b|worked|been\\s+(a|an|the|at|in|working|studying|employed|promoted|hired)\\b|studied|led\\b|built|managed|completed|finished|done\\s+(a|an|the|my)|earned|got\\s+(a|an|the|my)|received|won|published|shipped|launched|founded|interned|graduated|taught|trained|held|run\\s+(a|an|the)|written|passed|scored|certificat\\w*|degrees?|diplomas?|skills?\\s+in|knowledge\\s+of|fluency|proficiency|expertise)`),
  /\bi\s+(hold|held|earned|obtained|completed|finished|graduated|studied|majored|minored|worked|interned|led|managed|built|founded|co-founded|launched|shipped|won|received|scored|achieved|published|taught|trained|ran|grew|increased|reduced|saved|raised|delivered|designed|developed|created|authored|speak|spoke|know|knew|passed|attended|joined|quit|was\s+(promoted|hired|fired|laid\s+off|rejected|accepted|admitted|awarded))\b/,
  /\bi\s+(work|intern|study)\s+(at|for|as|on)\b/,
  new RegExp(`\\bi('m|\\s+am|\\s+was)\\s+((a|an|the)\\b${NOT_A_FACT}|fluent|native|bilingual|certified|qualified|licensed|proficient|expert|experienced|senior|junior|graduat\\w*|studying|working\\s+(at|for|as|in)|employed|unemployed|enrolled|currently|based|from|located|living\\s+in|\\d|top\\b|first\\b|one\\s+of|eligible|authori[sz]ed|citizen|resident)`),
  // Third person, statement of record.
  /\b(the\s+(user|candidate|applicant)|he|she)\s+(has|had|holds|held|is|was|worked|works|studied|studies|graduated|speaks|led|built|managed|earned|won|completed|interned|knows|scored|got|received|attended|joined)\b/,
  // Possessive facts.
  new RegExp(`\\b(my|his|her|the\\s+(user|candidate)'s)\\s+(\\w+\\s+)?(degrees?|gpa|grades?|marks|employers?|company|companies|manager|boss|internships?|thesis|dissertation|masters?|master's|bachelors?|bachelor's|mba|phd|msc|bsc|university|universit\\w+|school|college|alma\\s+mater|job\\s+title|certificat\\w*|ielts|toefl|gmat|gre|awards?|publications?|nationality|citizenship|visa|passport|age|birthday|birth\\s+date|address|phone|e-?mail|cefr)\\b`),
  /\b(my|his|her)\s+(current|previous|last|old|former|present)\s+(salary|pay|comp\w*|package|employer|company|role|job|position|title|manager|boss|team|level)\b/,
  /\b(my|his|her)\s+(\w+\s+)?(english|french|spanish|german|italian|danish|dutch|portuguese|swedish|norwegian|chinese|japanese|arabic|languages?|python|sql|excel)\s+(is|are|was|level|skills?\s+(is|are))\b/,
  /\b(my|his|her)\s+(time|stint|years?|months?|summer|role|job|work|internship|position|semester|exchange)\s+(at|with|in)\s+[a-z]/,
  // Levels and credentials tied to the person.
  new RegExp(`\\b${PERSON}\\b.*\\b(fluent|bilingual|proficient|conversational|business-level|working\\s+knowledge|mother\\s+tongue|native\\s+(speaker|level|in)|[abc][12]\\s+(level|in|english|french|spanish|german|italian|danish|dutch)|(english|french|spanish|german|italian|danish|dutch)\\s+[abc][12])\\b`),
  /\b(i'm|i\s+am|i\s+was|my\s+\w+\s+(is|was)|(he|she)\s+(is|was))\s+(an?\s+)?(expert|advanced|intermediate|beginner|basic|novice|fluent|native)\b/,
  /\b[abc][12]\s+(level\s+)?(in\s+)?(english|french|spanish|german|italian|danish|dutch|portuguese)\b/,
  new RegExp(`\\b${OWNS}\\b(\\W+[\\w']+){0,3}?\\W+(bachelor\\w*|master'?s|masters|msc|bsc|mba|phd|doctorate|diploma|degree|gpa|cum\\s+laude|summa|magna|honou?rs|valedictorian|dean'?s\\s+list)\\b`),
  new RegExp(`\\b${OWNS}\\b(\\W+[\\w']+){0,4}?\\W+(years?|months?)\\s+(of\\s+)?(experience|work|working|in\\s+the\\s+industry)\\b`),
  // Metrics, money and dates are facts wherever they appear.
  /\d+(\.\d+)?\s*(%|percent|per\s+cent|pct|bps|basis\s+points|x\s+(faster|more|growth))\b/, /\d+(\.\d+)?\s*%/,
  /[$€£¥₹₩₣₤]\s*\d|\d\s*[$€£¥₹]/,
  /\b\d+([.,]\d+)?\s*(k|m|mn|bn|million|billion|thousand|lakh|crore)\b/,
  /\b(usd|eur|gbp|chf|dkk|sek|nok|jpy|cny|inr|aud|cad|euros?|dollars?|pounds?|kroner|krona|francs?|rupees?)\b/,
  /\b(19|20)\d{2}\b/, /\b'\d{2}\b/,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}(st|nd|rd|th)?,?\s+)?\d{2,4}\b/,
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/, /\b\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?\b/,
  /\b(gpa|ielts|toefl|gmat|gre|cefr)\b/,
  /\b\d+\s*\+?\s*(years?|yrs?|months?)\s+(of\s+)?(experience|work|working)\b/,
]

export function isFactualClaim(norm) {
  return any(norm, FACTUAL)
}

// The vocabulary of a job posting. The user's own words about how they want
// things done rarely read like this; pasted posting text usually does.
const POSTING_TEXT = [
  /\b(responsibilities|requirements|qualifications|preferred\s+qualifications|minimum\s+qualifications|key\s+duties)\b/,
  /\b(we\s+are|we're|we\s+are\s+currently)\s+(looking|seeking|hiring|searching)\b/, /\bwe\s+offer\b/, /\bwhat\s+we\s+offer\b/,
  /\babout\s+(the\s+role|the\s+position|the\s+team|us|the\s+company|you)\b/, /\bthe\s+ideal\s+candidate\b/,
  /\byou\s+will\b/, /\byou'll\b/, /\bwhat\s+you('ll|\s+will)\s+(do|bring)\b/, /\byour\s+(role|responsibilities|profile|mission|impact)\b/,
  /\bjob\s+(description|posting|ad|advert|listing|offer|requirements?)\b/, /\bapply\s+now\b/, /\bhow\s+to\s+apply\b/,
  /\bequal\s+(opportunity|employment)\b/, /\bbenefits?\s+(include|package)\b/, /\bnice[\s-]to[\s-]have\b/, /\bmust[\s-]haves?\b/,
  /\bjoin\s+(our|us|the\s+team)\b/, /\bour\s+(team|company|client|mission|culture|values)\b/, /\bcompetitive\s+(salary|compensation|package)\b/,
  /\breporting\s+to\s+the\b/, /\bthe\s+successful\s+candidate\b/, /\b(key|main)\s+tasks\b/, /\bwhat\s+you\s+bring\b/,
  /\bcandidates?\s+(should|must|will)\b/, /\bapplicants?\s+(should|must|will)\b/,
]

export function looksLikePosting(norm) {
  return any(norm, POSTING_TEXT)
}

/**
 * The content reasons for one piece of text (a rule or its evidence quote).
 * Each check sees the normalized text; obfuscation and markup see the raw.
 */
export function contentReasons(raw) {
  const out = []
  const norm = normalizeText(raw)
  if (hasMarkup(raw)) out.push('markup')
  if (hasObfuscation(raw)) out.push('obfuscated')
  if (isAutoSubmit(norm)) out.push('auto-submit')
  if (isSkipReview(norm)) out.push('skip-review')
  if (hasUrl(norm)) out.push('url')
  if (hasShell(norm)) out.push('shell')
  if (hasRoleHeader(norm)) out.push('role-header')
  if (hasInjection(norm)) out.push('injection')
  if (hasSystemFile(norm)) out.push('system-file')
  if (hasFileReference(norm)) out.push('file-reference')
  if (isFactualClaim(norm)) out.push('factual-claim')
  return out
}

// ─── Candidate validation ────────────────────────────────────────────────────

const reason = (code) => ({ code, message: REASONS[code] })
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Check one candidate. `seen` is a Set of rule keys already present (other
 * candidates in the batch, pending rules, rules in user/_profile.md).
 * @returns {{ code: string, message: string }[]} empty when it passes
 */
export function checkCandidate(c, { seen = new Set() } = {}) {
  if (!isPlainObject(c)) return [reason('shape')]
  const codes = []
  if (Object.keys(c).some((k) => !CANDIDATE_FIELDS.has(k))) codes.push('shape')

  if (c.kind === undefined || c.kind === null || c.kind === '') codes.push('kind-missing')
  else if (typeof c.kind !== 'string' || !Object.hasOwn(KINDS, c.kind)) codes.push('kind-unknown')

  if (typeof c.change !== 'string') codes.push('shape')

  const ev = c.evidence
  let quote = null
  if (!isPlainObject(ev)) {
    codes.push(ev === undefined || ev === null ? 'evidence-missing' : 'shape')
  } else {
    if (Object.keys(ev).some((k) => !EVIDENCE_FIELDS.has(k))) codes.push('shape')
    const src = typeof ev.source === 'string' ? ev.source.trim() : ''
    quote = typeof ev.quote === 'string' ? ev.quote : null
    if (!src || quote === null || !quote.trim()) codes.push('evidence-missing')
    if (src) {
      const s = normalizeText(src).replace(/[\s_]+/g, '-')
      if (!Object.hasOwn(TRUSTED_SOURCES, s) || src !== s) {
        codes.push(UNTRUSTED_SOURCES.some((u) => s === u || s.includes(u)) ? 'evidence-untrusted' : 'evidence-source-unknown')
      }
    }
  }

  if (typeof c.change === 'string') {
    const len = c.change.trim().length
    if (len < CHANGE_LIMITS.min || len > CHANGE_LIMITS.max) codes.push('length')
    codes.push(...contentReasons(c.change))
    if (seen.has(ruleKey(c.change))) codes.push('duplicate')
  }
  if (quote !== null && quote.trim()) {
    const len = quote.trim().length
    if (len < QUOTE_LIMITS.min || len > QUOTE_LIMITS.max) codes.push('length')
    if (looksLikePosting(normalizeText(quote))) codes.push('evidence-posting-text')
    // The quote is shown to the user and kept in the pending file: it has to
    // be as clean as the rule. A fact in the user's own words is fine as
    // evidence ("I hate long cover letters, I wrote 40 of them") only if the
    // rule itself carries no fact, so factual-claim is not checked here.
    codes.push(...contentReasons(quote).filter((r) => r !== 'factual-claim'))
  }
  return [...new Set(codes)].map(reason)
}

/**
 * Check a whole retro. More than MAX_CANDIDATES refuses the batch: the gate
 * never picks which five to keep.
 * @param {unknown} input  an array, or `{ candidates: [...] }`
 * @param {{ existing?: string[] }} opts  rules already pending or applied
 * @returns {{ batchError: {code,message}|null, accepted: {index, candidate}[], rejected: {index, candidate, reasons}[] }}
 */
export function checkCandidates(input, { existing = [] } = {}) {
  const list = Array.isArray(input) ? input : isPlainObject(input) && Array.isArray(input.candidates) && Object.keys(input).length === 1 ? input.candidates : null
  if (!list) return { batchError: reason('not-an-array'), accepted: [], rejected: [] }
  if (list.length > MAX_CANDIDATES) {
    return {
      batchError: { code: 'too-many', message: `${list.length} candidates: ${REASONS['too-many']}` },
      accepted: [],
      rejected: list.map((candidate, index) => ({ index, candidate, reasons: [reason('too-many')] })),
    }
  }
  const seen = new Set(existing.map(ruleKey))
  const accepted = []
  const rejected = []
  list.forEach((candidate, index) => {
    const reasons = checkCandidate(candidate, { seen })
    if (reasons.length) rejected.push({ index, candidate, reasons })
    else {
      accepted.push({ index, candidate: { kind: candidate.kind, change: candidate.change.trim(), evidence: { source: candidate.evidence.source, quote: candidate.evidence.quote.trim() } } })
      seen.add(ruleKey(candidate.change))
    }
  })
  return { batchError: null, accepted, rejected }
}

// ─── Pending file ────────────────────────────────────────────────────────────

export function emptyPending() {
  return { version: 1, nextId: 1, items: [] }
}

/** Parse data/learn-pending.json. Missing/blank → empty. Corrupt → throws. */
export function parsePending(text) {
  if (text === null || text === undefined || !String(text).trim()) return emptyPending()
  let data
  try { data = JSON.parse(text) } catch (e) { throw new Error(`learn: the pending file is not valid JSON (${e.message})`) }
  if (!isPlainObject(data) || data.version !== 1 || !Number.isInteger(data.nextId) || data.nextId < 1 || !Array.isArray(data.items)) {
    throw new Error('learn: the pending file has an unexpected shape')
  }
  const ids = new Set()
  for (const it of data.items) {
    if (!isPlainObject(it) || !Number.isInteger(it.id) || it.id < 1 || ids.has(it.id) || it.id >= data.nextId) {
      throw new Error('learn: the pending file has a malformed or duplicate item id')
    }
    ids.add(it.id)
  }
  return data
}

export function renderPending(pending) {
  return JSON.stringify(pending, null, 2) + '\n'
}

/**
 * Number the survivors after the pending items. `minNextId` lets the caller
 * keep ids unique across a deleted pending file (the ledger's highest id + 1).
 */
export function addToPending(pending, accepted, { date, profile = null, minNextId = 1 } = {}) {
  let next = Math.max(pending.nextId, minNextId)
  const added = accepted.map(({ candidate }) => ({
    id: next++,
    kind: candidate.kind,
    change: candidate.change,
    evidence: { source: candidate.evidence.source, quote: candidate.evidence.quote },
    proposed: date,
    profile,
  }))
  return { pending: { version: 1, nextId: next, items: [...pending.items, ...added] }, added }
}

/** `"1,3"` / `"1, 3"` → [1, 3]. Anything else throws. */
export function parseIds(spec) {
  const s = String(spec ?? '').replace(/\s+/g, '')
  if (!/^[1-9]\d{0,5}(,[1-9]\d{0,5})*$/.test(s)) throw new Error(`learn: ids must be a comma-separated list of numbers, like 1,3 (got "${spec ?? ''}")`)
  return [...new Set(s.split(',').map(Number))]
}

export function removeFromPending(pending, ids) {
  const drop = new Set(ids)
  return { ...pending, items: pending.items.filter((it) => !drop.has(it.id)) }
}

/** Human view of the pending rules. */
export function renderList(pending) {
  if (!pending.items.length) return 'No pending rules.'
  const lines = []
  for (const it of pending.items) {
    lines.push(`#${it.id}  [${it.kind}]  ${it.change}`)
    lines.push(`     evidence (${it.evidence?.source}): "${it.evidence?.quote}"`)
    lines.push(`     proposed ${it.proposed}${it.profile ? ` · profile ${it.profile}` : ''} → ${TARGET_FILE} › ${KINDS[it.kind]?.section ?? '?'}`)
  }
  return lines.join('\n')
}

// ─── user/_profile.md ────────────────────────────────────────────────────────

/** The rule line written for one accepted item. */
export function renderRuleLine(item, date) {
  return `- ${item.change} _(learned ${date}, #${item.id})_`
}

const RULE_SUFFIX = /\s*_\(learned \d{4}-\d{2}-\d{2}, #\d+\)_\s*$/

/** Rules already in the `## Learned preferences` section, as written. */
export function existingRules(profileText) {
  const lines = String(profileText ?? '').replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => l.trim() === SECTION_HEADING)
  if (start === -1) return []
  const out = []
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const m = lines[i].match(/^- (.+)$/)
    if (m) out.push(m[1].replace(RULE_SUFFIX, ''))
  }
  return out
}

/**
 * Insert the rule lines into user/_profile.md: under `## Learned preferences`
 * (added at the end when missing), in the `### <section>` of each kind (added
 * at the end of the section when missing), after the subsection's last line.
 * Everything else in the file is left byte-for-byte.
 */
export function insertRules(profileText, items, date) {
  const crlf = /\r\n/.test(profileText)
  let lines = String(profileText).replace(/\r\n/g, '\n').split('\n')
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === ''
  if (trailingNewline) lines.pop()

  let start = lines.findIndex((l) => l.trim() === SECTION_HEADING)
  if (start === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    if (lines.length) lines.push('')
    lines.push(SECTION_HEADING, '', SECTION_INTRO)
    start = lines.length - 3
  }

  for (const item of items) {
    const sub = `### ${KINDS[item.kind].section}`
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break }
    let subAt = -1
    for (let i = start + 1; i < end; i++) if (lines[i].trim() === sub) { subAt = i; break }
    const line = renderRuleLine(item, date)
    if (subAt === -1) {
      let at = end
      while (at > start + 1 && lines[at - 1].trim() === '') at--
      const block = ['', sub, '', line]
      if (end < lines.length) block.push('')
      lines.splice(at, end - at, ...block)
      continue
    }
    let subEnd = end
    for (let i = subAt + 1; i < end; i++) if (/^#{2,3} /.test(lines[i])) { subEnd = i; break }
    let at = subEnd
    while (at > subAt + 1 && lines[at - 1].trim() === '') at--
    const block = at === subAt + 1 ? ['', line] : [line]
    if (at < lines.length && /^#{2,3} /.test(lines[at])) block.push('')
    lines.splice(at, 0, ...block)
  }

  let out = lines.join('\n') + '\n'
  if (crlf) out = out.replace(/\n/g, '\r\n')
  return out
}

/**
 * Plan an apply: the accepted ids must all be pending, each is re-checked by
 * the gate (the pending file is a plain file anyone with write access could
 * edit), and each must have been proposed for the active profile. Any problem
 * refuses the whole apply; nothing is partly written.
 * @returns {{ ok: true, items, text } | { ok: false, errors: string[] }}
 */
export function planApply(pending, ids, profileText, { date, activeProfile = null }) {
  const errors = []
  const byId = new Map(pending.items.map((it) => [it.id, it]))
  const items = []
  const seen = new Set(existingRules(profileText).map(ruleKey))
  for (const id of ids) {
    const it = byId.get(id)
    if (!it) { errors.push(`#${id} is not pending (see: learn.mjs list)`); continue }
    if ((it.profile ?? null) !== (activeProfile ?? null)) {
      errors.push(`#${id} was proposed for profile ${it.profile ?? '(none)'} but the active profile is ${activeProfile ?? '(none)'}`)
      continue
    }
    const reasons = checkCandidate({ kind: it.kind, change: it.change, evidence: it.evidence }, { seen })
    if (reasons.length) { errors.push(`#${id} no longer passes the gate: ${reasons.map((r) => r.code).join(', ')}`); continue }
    seen.add(ruleKey(it.change))
    items.push(it)
  }
  if (errors.length) return { ok: false, errors }
  return { ok: true, items, text: insertRules(profileText, items, date) }
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim()

export function ledgerHeader() {
  return LEDGER_COLUMNS.join('\t') + '\n'
}

/** One ledger row: date, id, action (applied|rejected), kind, target, hash, summary. */
export function formatLedgerRow({ date, item, action }) {
  const target = action === 'applied' ? `${TARGET_FILE} › ${KINDS[item.kind]?.section ?? item.kind}` : ''
  const summary = cell(item.change).slice(0, 80)
  return [date, item.id, action, item.kind, target, ruleHash(item.change), summary].map(cell).join('\t') + '\n'
}

/** Highest id the ledger has seen (0 when none). */
export function maxLedgerId(ledgerText) {
  let max = 0
  for (const line of String(ledgerText ?? '').split('\n').slice(1)) {
    const id = Number(line.split('\t')[1])
    if (Number.isInteger(id) && id > max) max = id
  }
  return max
}

// ─── Headless refusal ────────────────────────────────────────────────────────

/** Env vars that mark an unattended or agent-driven run. */
export const HEADLESS_ENV = ['CI', 'GITHUB_ACTIONS', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_SANDBOX', 'CODEX_CI']

/**
 * Why `apply` must refuse here, or null when a person is at a terminal.
 * No TTY on stdin or stdout, CI, or running under an agent (Claude Code sets
 * CLAUDECODE / CLAUDE_CODE_ENTRYPOINT for every tool call; the app's workers
 * are `claude -p` children) all refuse. There is no flag to override it.
 */
export function headlessReason({ stdinIsTTY, stdoutIsTTY, env = {} }) {
  if (!stdinIsTTY) return 'stdin is not a terminal'
  if (!stdoutIsTTY) return 'stdout is not a terminal'
  for (const name of HEADLESS_ENV) {
    const v = env[name]
    if (v !== undefined && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false') {
      return `${name} is set (an unattended or agent-driven run)`
    }
  }
  return null
}
