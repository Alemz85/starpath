#!/usr/bin/env python3
"""
scripts/jobspy/scan.py — Aggregator scanner (Indeed + Google)

Scrapes Indeed + Google Jobs via the python-jobspy library, applies the
same filter pipeline as scripts/scan.mjs (title positive/negative keywords,
lang blocklist, EU location allowlist, URL dedup), and writes new rows to
STAGING files:
  - data/scan-history.jobspy.tsv
  - data/pipeline.jobspy.md

scripts/merge-scan-staging.mjs picks these up after the scan finishes and
merges them into the canonical data/scan-history.tsv + data/pipeline.md.
This staging pattern lets JobSpy and scan.mjs run in parallel without
racing on the canonical files.

Zero LLM tokens — pure HTTP scraping.

Usage (run from repo root):
  scripts/jobspy/.venv/bin/python scripts/jobspy/scan.py
  scripts/jobspy/.venv/bin/python scripts/jobspy/scan.py --dry-run
  scripts/jobspy/.venv/bin/python scripts/jobspy/scan.py --max-rows 50
"""

import argparse
import re
import sys
from datetime import date as _date, datetime as _datetime, timezone as _timezone
from pathlib import Path

try:
    import yaml
except ImportError:
    print(
        "[JobSpy] Missing dependency 'pyyaml'. Run scripts/jobspy/setup.sh first.",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    from jobspy import scrape_jobs
except ImportError:
    print(
        "[JobSpy] Missing dependency 'python-jobspy'. Run scripts/jobspy/setup.sh first.",
        file=sys.stderr,
    )
    sys.exit(1)


# ── Paths (relative to repo root, where this script is invoked from) ─────

REPO_ROOT = Path.cwd()
PORTALS_PATH = REPO_ROOT / "user" / "portals.yml"
PROFILE_PATH = REPO_ROOT / "user" / "profile.yml"
SCAN_HISTORY_PATH = REPO_ROOT / "data" / "scan-history.tsv"
PIPELINE_PATH = REPO_ROOT / "data" / "pipeline.md"
APPLICATIONS_PATH = REPO_ROOT / "data" / "applications.md"
STAGING_HISTORY = REPO_ROOT / "data" / "scan-history.jobspy.tsv"
STAGING_PIPELINE = REPO_ROOT / "data" / "pipeline.jobspy.md"

HISTORY_HEADER = (
    "url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscan_dates"
)


# ── Filter logic — mirrors scripts/scan-core.mjs (word-boundary matching) ──
#
# ── Why word-aware matching (the bug this section fixes) ──────────────────
# The aggregator scanner is the highest-VOLUME source (Indeed + Google), yet it
# used to filter with raw Python `substring in title`, while the ATS scanner
# (scan-core.mjs) was upgraded to WORD-BOUNDARY matching. Same portals.yml
# keyword lists, two different — and on the aggregator side, worse — results:
#
#   FALSE POSITIVE (good junior roles wrongly DROPPED): a bare negative "Lead"
#   killed "Leadership Operations Analyst" and "Leading Strategy Analyst"; the
#   exact junior roles the funnel exists to surface vanished from the inbox.
#
#   FALSE POSITIVE (junk wrongly KEPT): a positive "Ops" matched inside
#   "Synopsys", "BI" inside "ambitious" — postings with no real topical signal
#   slipped through. On the language side, the FR/NL token "stage" nuked the
#   English "Staged Rollout Manager".
#
# keyword_matches() now mirrors scan-core.mjs's compileKeyword EXACTLY: a
# keyword matches only as a whole word/phrase. "Boundary" means the char before
# and after is not a letter or digit (so spaces, punctuation, accented letters,
# and string ends all qualify — deliberately looser than \b so "R&D", "Pre-Sales"
# and "(m/w/d)" still match). Multi-word phrases are whitespace-tolerant. This
# also retires the bespoke _UK_TOKEN_RE special-case: "uk" is now word-aware like
# every other token, for free.

# Generic European target-geography allowlist — kept in lockstep with
# scan-core.mjs › DEFAULT_LOCATION_ALLOWLIST (system-layer reference data, NOT
# one user's preference; a user narrows/widens it via location_allowlist in
# portals.yml). Matching is word-aware, so "rome" no longer hits "Jerome" and
# "milan" needs its own entry to also accept "Milano" (both are listed, exactly
# as the Node side does).
ALLOWED_LOCATIONS = [
    "spain", "barcelona", "madrid", "valencia",
    "ireland", "dublin",
    "netherlands", "amsterdam", "rotterdam", "eindhoven", "the hague",
    "denmark", "copenhagen",
    "united kingdom", "uk", "london", "manchester", "cambridge",
    "italy", "milan", "milano", "rome",
    "germany", "munich", "münchen", "berlin", "hamburg", "frankfurt", "cologne",
    "france", "paris",
    "portugal", "lisbon", "porto",
    "belgium", "brussels",
    "sweden", "stockholm",
    "switzerland", "zurich", "zürich", "geneva",
    "austria", "vienna",
    "finland", "helsinki",
    "norway", "oslo",
    "poland", "warsaw", "krakow",
    "remote",
    # EU-scoped remote/EMEA phrases — EU companies often use these for positions
    # that are technically open to the candidate's target cities. (scan-core.mjs
    # leans on its own GENERIC_LOCATION_TOKENS set for the same intent; here we
    # keep them inline so the aggregator accepts "Remote - Europe" / "EMEA".)
    "europe", "emea",
]


def _keyword_pattern(keyword: str) -> "re.Pattern | None":
    """Compile a word-boundary matcher for one keyword, or None if it's blank.

    Mirrors scan-core.mjs › compileKeyword:
      - left boundary:  start-of-string OR a non-[a-z0-9] char
      - right boundary: end-of-string  OR a non-[a-z0-9] char
      - internal whitespace is collapsed to \\s+ so "Head of" tolerates
        "Head  of" / "Head\\tof".
    Lookarounds are used so adjacent matches don't consume the boundary char.
    The keyword is trimmed and lowercased; the haystack is lowercased by callers.
    """
    trimmed = keyword.strip().lower()
    if not trimmed:
        return None
    # Split on whitespace, escape each token, rejoin with \s+ so multi-word
    # phrases ("Head of") tolerate odd internal spacing. Splitting BEFORE
    # escaping avoids Python's re.escape escaping the space itself (it does on
    # 3.7+), which is the only divergence from scan-core.mjs's escapeRegExp.
    body = r"\s+".join(re.escape(tok) for tok in trimmed.split())
    return re.compile(rf"(?:^|[^a-z0-9]){body}(?:$|[^a-z0-9])", re.IGNORECASE)


def keyword_matches(text: str, keyword: str) -> bool:
    """True when `text` contains `keyword` as a whole word/phrase (case-insensitive)."""
    if not text or not keyword:
        return False
    pat = _keyword_pattern(keyword)
    return bool(pat and pat.search(text.lower()))


def build_title_filter(positive_kw, negative_kw):
    """A title passes when ≥1 positive matches (or there are no positives) AND
    no negative matches — word-boundary aware, identical to scan-core.mjs."""
    pos = [p for p in (_keyword_pattern(k) for k in (positive_kw or [])) if p]
    neg = [p for p in (_keyword_pattern(k) for k in (negative_kw or [])) if p]

    def check(title: str) -> bool:
        if not title:
            return False
        lower = title.lower()
        if pos and not any(p.search(lower) for p in pos):
            return False
        if any(p.search(lower) for p in neg):
            return False
        return True

    return check


def build_lang_filter(blocklist):
    """Reject a title containing any blocklist token (word-boundary aware), so a
    FR/NL token like "stage" no longer nukes the English "Staged Rollout"."""
    bl = [p for p in (_keyword_pattern(t) for t in (blocklist or [])) if p]
    if not bl:
        return lambda title: True

    def check(title: str) -> bool:
        if not title:
            return True
        lower = title.lower()
        return not any(p.search(lower) for p in bl)

    return check


# Pre-compiled location matchers — word-aware, so "uk" no longer needs a bespoke
# regex and "rome" no longer hits "Jerome".
_LOCATION_PATTERNS = [p for p in (_keyword_pattern(t) for t in ALLOWED_LOCATIONS) if p]


def is_allowed_location(loc: str) -> bool:
    """Return True if the location names an allowed EU city/country/region, or is
    empty/unknown (soft filter — the API often omits location).

    Word-boundary aware throughout: "Duke University" / "Fukuoka" no longer match
    "uk", and "Jerome, USA" no longer matches "rome". EU-scoped remote strings
    ("Remote - Europe", "EMEA") still pass via their own tokens.
    """
    if not loc or not loc.strip():
        return True
    lower = loc.lower()
    return any(p.search(lower) for p in _LOCATION_PATTERNS)


def set_location_allowlist(tokens):
    """Replace the default EU allowlist with portals.yml `location_allowlist`.

    Parity with scan-core.mjs › buildLocationFilter: a NON-EMPTY user list
    replaces the default; empty/missing keeps it. Lets a profile narrow the
    geography (e.g. one city + country) without touching system code. Must be
    called before the scrape loop.
    """
    global _LOCATION_PATTERNS
    cleaned = [str(t) for t in (tokens or []) if str(t).strip()]
    if cleaned:
        _LOCATION_PATTERNS = [p for p in (_keyword_pattern(t) for t in cleaned) if p]


# ── Dedup — read URLs from canonical files ──────────────────────────────

URL_RE = re.compile(r"https?://[^\s|)]+")
PIPELINE_URL_RE = re.compile(r"-\s*\[[ x]\]\s*(https?://\S+)")

# Patterns that appear at the end of company names but don't distinguish the
# company (e.g. "Stripe, Inc." vs "Stripe").  Stripped before building the
# intra-run company::role dedup key.
_COMPANY_SUFFIX_RE = re.compile(
    r",?\s*(?:inc\.?|ltd\.?|llc\.?|gmbh|s\.?a\.?|s\.?l\.?|b\.?v\.?|n\.?v\.?|plc\.?|corp\.?|co\.?)$",
    re.IGNORECASE,
)

# Location-style suffixes appended to role titles by some aggregators:
# "Business Analyst - London", "Business Analyst, Amsterdam", etc.
# Stripped before building the intra-run company::role dedup key.
_TITLE_LOCATION_SUFFIX_RE = re.compile(
    r"[\s,\-–—|]+(?:remote|hybrid|on.site|"
    + "|".join([
        "spain", "barcelona", "madrid",
        "ireland", "dublin",
        "netherlands", "amsterdam",
        "denmark", "copenhagen",
        "london", "united kingdom", "uk",
        "italy", "milan", "rome",
        "germany", "munich", "berlin", "hamburg", "frankfurt",
        "france", "paris",
        "portugal", "lisbon",
        "belgium", "brussels",
        "sweden", "stockholm",
        "switzerland", "zurich", "geneva",
        "austria", "vienna",
        "finland", "helsinki",
        "norway", "oslo",
    ])
    + r")[\s,\-–—|]*$",
    re.IGNORECASE,
)


def _normalize_company(name: str) -> str:
    """Normalise a company name for dedup key purposes.

    Strips legal-entity suffixes (Inc., Ltd., GmbH …) and trims whitespace.
    Does NOT lowercase — caller is responsible.
    """
    return _COMPANY_SUFFIX_RE.sub("", name.strip()).strip(" ,.")


def _normalize_title(title: str) -> str:
    """Normalise a job title for dedup key purposes.

    Strips trailing location annotations added by aggregators
    (e.g. "Business Analyst - London") so the same role posted under two
    search-city queries deduplicates correctly.
    """
    return _TITLE_LOCATION_SUFFIX_RE.sub("", title.strip()).strip()


def make_company_role_key(company: str, title: str) -> str:
    """Return a normalised 'company::role' string for intra-run dedup."""
    return (
        _normalize_company(company).lower()
        + "::"
        + _normalize_title(title).lower()
    )


# ── Posting-date recency (parity with scan-core.mjs › parsePostingDate) ──────
#
# JobSpy exposes the role's TRUE posting date per row (the `date` column, an
# ISO YYYY-MM-DD string). The scanner stamps first_seen=today, so a job posted
# 60 days ago that JobSpy surfaces today looks brand-new. We can't widen the
# staging TSV schema here (the merge keys off fixed columns + the pipeline-line
# format), but we CAN read the posting date to report a sourcing-quality signal:
# what fraction of "new" rows are actually long-open reposts. That tells the
# user (and a future scoring pass) how fresh this aggregator batch really is.


def normalize_posting_date(raw) -> "str | None":
    """Normalise a raw posting date to bare 'YYYY-MM-DD', or None.

    Mirrors scan-core.mjs › parsePostingDate: accepts a bare date verbatim, an
    ISO timestamp, or epoch seconds/ms; fails open (None) on anything dubious
    (incl. pandas NaN / NaT, which compare unequal to themselves).
    """
    if raw is None:
        return None
    # pandas NaN / NaT are floats/objects that are not equal to themselves.
    try:
        if raw != raw:  # NaN/NaT
            return None
    except Exception:
        pass

    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return None
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
            return s
        if re.fullmatch(r"\d{10,}", s):  # epoch as string
            raw = int(s)
        else:
            try:
                dt = _datetime.fromisoformat(s.replace("Z", "+00:00"))
                return dt.astimezone(_timezone.utc).date().isoformat()
            except ValueError:
                return None

    if isinstance(raw, (int, float)):
        try:
            secs = raw / 1000.0 if abs(raw) >= 1e11 else float(raw)
            return _datetime.fromtimestamp(secs, _timezone.utc).date().isoformat()
        except (ValueError, OverflowError, OSError):
            return None

    # date / datetime objects
    if isinstance(raw, _datetime):
        return raw.astimezone(_timezone.utc).date().isoformat() if raw.tzinfo else raw.date().isoformat()
    if isinstance(raw, _date):
        return raw.isoformat()
    return None


def posting_age_days(posted_date: "str | None", today: str) -> "int | None":
    """Whole days between a normalised posting date and `today` (YYYY-MM-DD).

    None for unparseable input. Negative (future-dated) collapses to 0.
    """
    if not posted_date:
        return None
    try:
        p = _date.fromisoformat(posted_date)
        t = _date.fromisoformat(today)
    except ValueError:
        return None
    return max(0, (t - p).days)


def _load_tsv_urls(path: Path) -> set:
    """Extract the first tab-separated column (URL) from a TSV file."""
    urls = set()
    if not path.exists():
        return urls
    with path.open(encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i == 0:
                continue  # header
            if not line.strip():
                continue
            url = line.split("\t", 1)[0].strip()
            if url:
                urls.add(url)
    return urls


def load_seen_urls() -> set:
    """Load all previously-seen URLs from canonical + staging files.

    Reading the staging files (scan-history.jobspy.tsv, pipeline.jobspy.md)
    means a partial previous run that was never merged won't produce duplicate
    rows — the same URLs are simply skipped again.
    """
    seen = set()

    # Canonical scan history (merged results from all previous runs)
    seen |= _load_tsv_urls(SCAN_HISTORY_PATH)

    # Staging TSV from a previous JobSpy run that may not have been merged yet
    seen |= _load_tsv_urls(STAGING_HISTORY)

    # Canonical pipeline inbox
    if PIPELINE_PATH.exists():
        for m in PIPELINE_URL_RE.finditer(
            PIPELINE_PATH.read_text(encoding="utf-8")
        ):
            seen.add(m.group(1).strip())

    # Staging pipeline from a previous run
    if STAGING_PIPELINE.exists():
        for m in PIPELINE_URL_RE.finditer(
            STAGING_PIPELINE.read_text(encoding="utf-8")
        ):
            seen.add(m.group(1).strip())

    # Active applications tracker
    if APPLICATIONS_PATH.exists():
        for m in URL_RE.finditer(
            APPLICATIONS_PATH.read_text(encoding="utf-8")
        ):
            seen.add(m.group(0).strip())

    return seen


# ── City → country_indeed map ───────────────────────────────────────────

CITY_TO_COUNTRY_INDEED = {
    "dublin": "ireland",
    "amsterdam": "netherlands",
    "rotterdam": "netherlands",
    "barcelona": "spain",
    "madrid": "spain",
    "milan": "italy",
    "rome": "italy",
    "copenhagen": "denmark",
    "wien": "austria",
    "vienna": "austria",
    "london": "uk",
    "paris": "france",
    "berlin": "germany",
    "munich": "germany",
    "frankfurt": "germany",
    "hamburg": "germany",
    "lisbon": "portugal",
    "brussels": "belgium",
    "stockholm": "sweden",
    "zurich": "switzerland",
    "geneva": "switzerland",
    "helsinki": "finland",
    "oslo": "norway",
}


# ── Defaults — kept tight; tunable via CLI ──────────────────────────────

# Fallback keyword list — used only if profile.yml.target_roles.primary
# is missing or yields no usable terms after the transformation below.
# These are deliberately generic role families (not the current user's specific
# targets) so the system layer stays user-agnostic per the Data Contract.
# Populate user/profile.yml → target_roles.primary for personalised keywords.
FALLBACK_KEYWORDS: list[str] = []  # fail-closed: prompt user to set profile.yml

DEFAULT_RESULTS_PER_QUERY = 20
DEFAULT_HOURS_OLD = 168   # 7 days
DEFAULT_MAX_ROWS = 100    # hard ceiling per run

# Maximum words per derived keyword — anything longer is a phrase that
# returns near-zero matches on Indeed/Google.
MAX_WORDS_PER_KEYWORD = 4


def _cell(row, key):
    """Read one pandas cell as a clean stripped string.

    pandas hands back float('nan') for missing cells, and NaN is TRUTHY in
    Python — so the obvious `row.get(k) or ""` keeps it and str() renders the
    literal 'nan', which then leaks into staged TSVs as a company/title.
    """
    val = row.get(key)
    if val is None or (isinstance(val, float) and val != val):
        return ""
    return str(val).strip()


def derive_keywords_from_target_roles(target_roles_primary):
    """
    Turn user/profile.yml `target_roles.primary` (composite role strings)
    into clean JobSpy search terms.

    Examples:
      "Strategy & Operations Analyst"
        -> ["Strategy & Operations Analyst"]
      "Tech Sales / Solutions Consultant"
        -> ["Tech Sales", "Solutions Consultant"]
      "Business Analyst (Tech)"
        -> ["Business Analyst"]
      "Rotational / Early Careers / Graduate / Leadership Development Program (any tech function)"
        -> ["Rotational", "Early Careers", "Graduate", "Leadership Development Program"]

    Splits on '/' and em-dash, strips parentheticals, dedups
    case-insensitively, drops phrases longer than MAX_WORDS_PER_KEYWORD.
    """
    if not target_roles_primary:
        return []
    out = []
    seen = set()
    for raw in target_roles_primary:
        cleaned = re.sub(r"\([^)]*\)", "", str(raw)).strip()
        for part in re.split(r"[/—]", cleaned):
            part = part.strip(" -")
            if not part:
                continue
            if len(part.split()) > MAX_WORDS_PER_KEYWORD:
                continue
            key = part.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(part)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        description="JobSpy aggregator scanner (Indeed + Google)"
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="Skip the file writes (still hits the network so filter behavior is observable)")
    parser.add_argument("--keywords",
                        help="Comma-separated keywords (default: derived from "
                             "user/profile.yml target_roles.primary)")
    parser.add_argument("--cities",
                        help="Comma-separated cities (default: profile.yml preferred_cities)")
    parser.add_argument("--results-per-query", type=int,
                        default=DEFAULT_RESULTS_PER_QUERY)
    parser.add_argument("--hours-old", type=int, default=DEFAULT_HOURS_OLD)
    parser.add_argument("--max-rows", type=int, default=DEFAULT_MAX_ROWS)
    args = parser.parse_args()

    if not PORTALS_PATH.exists():
        print(f"[JobSpy] Error: {PORTALS_PATH} not found. Run onboarding first.",
              file=sys.stderr)
        return 1

    portals_cfg = yaml.safe_load(PORTALS_PATH.read_text(encoding="utf-8")) or {}
    profile_cfg = (
        yaml.safe_load(PROFILE_PATH.read_text(encoding="utf-8"))
        if PROFILE_PATH.exists() else {}
    ) or {}

    title_filter_cfg = portals_cfg.get("title_filter", {}) or {}
    pos_kw = title_filter_cfg.get("positive", []) or []
    neg_kw = title_filter_cfg.get("negative", []) or []
    lang_blocklist = portals_cfg.get("lang_blocklist", []) or []

    title_filter = build_title_filter(pos_kw, neg_kw)
    lang_filter = build_lang_filter(lang_blocklist)

    location_allowlist = portals_cfg.get("location_allowlist", []) or []
    set_location_allowlist(location_allowlist)
    if location_allowlist:
        print(f"[JobSpy] Location allowlist override: {len(location_allowlist)} tokens "
              f"({', '.join(str(t) for t in location_allowlist)})", flush=True)

    if args.cities:
        cities = [c.strip() for c in args.cities.split(",") if c.strip()]
    else:
        loc = profile_cfg.get("location", {}) or {}
        cities = loc.get("preferred_cities") or [
            "Barcelona", "Madrid", "Dublin", "Amsterdam", "London"
        ]

    if args.keywords:
        keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
        keyword_source = "CLI --keywords flag"
    else:
        primary = (profile_cfg.get("target_roles", {}) or {}).get("primary", []) or []
        derived = derive_keywords_from_target_roles(primary)
        if derived:
            keywords = derived
            keyword_source = "profile.yml target_roles.primary"
        elif FALLBACK_KEYWORDS:
            keywords = FALLBACK_KEYWORDS
            keyword_source = "built-in fallback list"
        else:
            print(
                "[JobSpy] Error: no keywords found. "
                "Set target_roles.primary in user/profile.yml or pass --keywords.",
                file=sys.stderr,
            )
            return 1

    today = _date.today().isoformat()
    seen = load_seen_urls()

    print(f"[JobSpy] Loaded filters: {len(pos_kw)} positive / {len(neg_kw)} negative "
          f"title keywords, {len(lang_blocklist)} lang tokens", flush=True)
    print(f"[JobSpy] Cities ({len(cities)}): {', '.join(cities)}", flush=True)
    print(f"[JobSpy] Keywords ({len(keywords)}, source: {keyword_source}): "
          f"{', '.join(keywords)}", flush=True)
    print(f"[JobSpy] Dedup baseline: {len(seen)} known URLs", flush=True)
    print(f"[JobSpy] results_per_query={args.results_per_query}  "
          f"hours_old={args.hours_old}  max_rows={args.max_rows}", flush=True)
    if args.dry_run:
        print("[JobSpy] (dry run — no files will be written)", flush=True)

    new_rows = []
    intra_run_seen_urls = set()
    intra_run_seen_company_role = set()

    total_raw = 0
    total_title_filtered = 0
    total_lang_filtered = 0
    total_loc_filtered = 0
    total_dupes = 0
    # Recency accounting over the rows we KEPT (sourcing-quality signal).
    kept_with_date = 0
    kept_stale_repost = 0  # posted before the stale window (default 90d)
    STALE_DAYS = 90

    capped = False
    for keyword in keywords:
        if capped:
            break
        for city in cities:
            if capped:
                break
            # Use the known mapping; fall back to "worldwide" (Indeed accepts it)
            # rather than silently defaulting to a specific country.
            country_indeed = CITY_TO_COUNTRY_INDEED.get(city.lower(), "worldwide")
            print(f"[JobSpy] → {keyword!r} in {city} "
                  f"(indeed/{country_indeed} + google)", flush=True)
            try:
                df = scrape_jobs(
                    site_name=["indeed", "google"],
                    search_term=keyword,
                    google_search_term=f"{keyword} jobs in {city}",
                    location=city,
                    results_wanted=args.results_per_query,
                    hours_old=args.hours_old,
                    country_indeed=country_indeed,
                    verbose=0,
                )
            except Exception as e:
                print(f"[JobSpy]   x {type(e).__name__}: {e}", flush=True)
                continue

            if df is None or df.empty:
                print("[JobSpy]   . 0 hits", flush=True)
                continue

            kept = 0
            for _, row in df.iterrows():
                total_raw += 1
                title = _cell(row, "title")
                company = _cell(row, "company")
                location_raw = _cell(row, "location")
                url = _cell(row, "job_url_direct") or _cell(row, "job_url")
                site = _cell(row, "site").lower()

                if not url or not title or not company:
                    continue
                if not title_filter(title):
                    total_title_filtered += 1
                    continue
                if not lang_filter(title):
                    total_lang_filtered += 1
                    continue
                if not is_allowed_location(location_raw):
                    total_loc_filtered += 1
                    continue
                if url in seen or url in intra_run_seen_urls:
                    total_dupes += 1
                    continue
                role_key = make_company_role_key(company, title)
                if role_key in intra_run_seen_company_role:
                    total_dupes += 1
                    continue

                intra_run_seen_urls.add(url)
                intra_run_seen_company_role.add(role_key)

                # Recency accounting: JobSpy gives the role's true posting date
                # (the `date` column). We don't widen the staging schema, but we
                # tally how many kept rows are long-open reposts so the summary
                # reflects how fresh this aggregator batch actually is.
                posted = normalize_posting_date(row.get("date"))
                if posted is not None:
                    kept_with_date += 1
                    age = posting_age_days(posted, today)
                    if age is not None and age > STALE_DAYS:
                        kept_stale_repost += 1

                new_rows.append({
                    "url": url,
                    "first_seen": today,
                    "portal": f"jobspy-{site}" if site else "jobspy",
                    "title": title,
                    "company": company,
                    "location": location_raw,
                    "status": "added",
                    "scan_dates": today,
                })
                kept += 1

                if len(new_rows) >= args.max_rows:
                    print(f"[JobSpy]   ! max-rows={args.max_rows} cap hit; "
                          f"stopping early", flush=True)
                    capped = True
                    break

            print(f"[JobSpy]   ok {kept} kept (of {len(df)} raw)", flush=True)

    print(
        f"[JobSpy] Filter summary: {total_raw} raw  "
        f"{total_title_filtered} title-rej  "
        f"{total_lang_filtered} lang-rej  "
        f"{total_loc_filtered} loc-rej  "
        f"{total_dupes} dupes  "
        f"{len(new_rows)} kept",
        flush=True,
    )
    if kept_with_date:
        pct = round(100 * kept_stale_repost / kept_with_date)
        print(
            f"[JobSpy] Recency: {kept_stale_repost}/{kept_with_date} kept rows "
            f"are reposts older than {STALE_DAYS}d ({pct}%) — these are long-open "
            f"listings, not fresh openings.",
            flush=True,
        )

    if args.dry_run:
        print(f"[JobSpy] Dry run complete. Would have staged {len(new_rows)} rows.",
              flush=True)
        return 0

    # No new rows: clear stale staging files so the merge step is a no-op
    if not new_rows:
        if STAGING_HISTORY.exists():
            STAGING_HISTORY.unlink()
        if STAGING_PIPELINE.exists():
            STAGING_PIPELINE.unlink()
        print("[JobSpy] No new rows; staging files cleared.", flush=True)
        return 0

    STAGING_HISTORY.parent.mkdir(parents=True, exist_ok=True)
    with STAGING_HISTORY.open("w", encoding="utf-8", newline="") as f:
        f.write(HISTORY_HEADER + "\n")
        for r in new_rows:
            cols = [
                r["url"],
                r["first_seen"],
                r["portal"],
                r["title"].replace("\t", " "),
                r["company"].replace("\t", " "),
                r["location"].replace("\t", " "),
                r["status"],
                r["scan_dates"],
            ]
            f.write("\t".join(cols) + "\n")

    with STAGING_PIPELINE.open("w", encoding="utf-8") as f:
        for r in new_rows:
            f.write(f"- [ ] {r['url']} | {r['company']} | {r['title']}\n")

    print(f"[JobSpy] Staged {len(new_rows)} rows -> {STAGING_HISTORY}",
          flush=True)
    print(f"[JobSpy] Staged {len(new_rows)} pipeline lines -> {STAGING_PIPELINE}",
          flush=True)
    print("[JobSpy] Done. Run `node scripts/merge-scan-staging.mjs` to merge "
          "into canonical files.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
