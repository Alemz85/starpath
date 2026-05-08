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
from datetime import date as _date
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


# ── Filter logic — mirrors scripts/scan.mjs ──────────────────────────────

# Copy of scan.mjs:273-289 ALLOWED_LOCATIONS — kept in sync with the Node version.
ALLOWED_LOCATIONS = [
    "spain", "barcelona", "madrid",
    "ireland", "dublin",
    "netherlands", "amsterdam", "rotterdam",
    "denmark", "copenhagen",
    "united kingdom", " uk", "london",
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
]


def build_title_filter(positive_kw, negative_kw):
    pos = [k.lower() for k in (positive_kw or [])]
    neg = [k.lower() for k in (negative_kw or [])]

    def check(title: str) -> bool:
        if not title:
            return False
        lower = title.lower()
        if pos and not any(k in lower for k in pos):
            return False
        if any(k in lower for k in neg):
            return False
        return True

    return check


def build_lang_filter(blocklist):
    bl = [t.lower() for t in (blocklist or [])]
    if not bl:
        return lambda title: True

    def check(title: str) -> bool:
        if not title:
            return True
        lower = title.lower()
        return not any(t in lower for t in bl)

    return check


def is_allowed_location(loc: str) -> bool:
    # Empty/unknown locations pass through — mirrors scan.mjs:296
    if not loc or not loc.strip():
        return True
    lower = loc.lower()
    return any(l in lower for l in ALLOWED_LOCATIONS)


# ── Dedup — read URLs from canonical files ──────────────────────────────

URL_RE = re.compile(r"https?://[^\s|)]+")
PIPELINE_URL_RE = re.compile(r"-\s*\[[ x]\]\s*(https?://\S+)")


def load_seen_urls() -> set:
    seen = set()
    if SCAN_HISTORY_PATH.exists():
        with SCAN_HISTORY_PATH.open(encoding="utf-8") as f:
            for i, line in enumerate(f):
                if i == 0:
                    continue
                if not line.strip():
                    continue
                url = line.split("\t", 1)[0]
                if url:
                    seen.add(url)
    if PIPELINE_PATH.exists():
        for m in PIPELINE_URL_RE.finditer(
            PIPELINE_PATH.read_text(encoding="utf-8")
        ):
            seen.add(m.group(1))
    if APPLICATIONS_PATH.exists():
        for m in URL_RE.finditer(
            APPLICATIONS_PATH.read_text(encoding="utf-8")
        ):
            seen.add(m.group(0))
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
FALLBACK_KEYWORDS = [
    "Strategy Analyst",
    "Business Analyst",
    "Operations Analyst",
    "Data Analyst",
    "Solutions Consultant",
    "Graduate Program",
    "Customer Engineer",
]

DEFAULT_RESULTS_PER_QUERY = 20
DEFAULT_HOURS_OLD = 168   # 7 days
DEFAULT_MAX_ROWS = 100    # hard ceiling per run

# Maximum words per derived keyword — anything longer is a phrase that
# returns near-zero matches on Indeed/Google.
MAX_WORDS_PER_KEYWORD = 4


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
        else:
            keywords = FALLBACK_KEYWORDS
            keyword_source = "fallback (profile.yml empty or unreadable)"

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

    capped = False
    for keyword in keywords:
        if capped:
            break
        for city in cities:
            if capped:
                break
            country_indeed = CITY_TO_COUNTRY_INDEED.get(city.lower(), "spain")
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
                title = str(row.get("title") or "").strip()
                company = str(row.get("company") or "").strip()
                location_raw = str(row.get("location") or "").strip()
                url = str(
                    row.get("job_url_direct") or row.get("job_url") or ""
                ).strip()
                site = str(row.get("site") or "").strip().lower()

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
                role_key = f"{company.lower()}::{title.lower()}"
                if role_key in intra_run_seen_company_role:
                    total_dupes += 1
                    continue

                intra_run_seen_urls.add(url)
                intra_run_seen_company_role.add(role_key)

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
