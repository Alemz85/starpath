#!/usr/bin/env python3
"""
scripts/jobspy/test_filters.py — Unit tests for scan.py filter logic.

Run from repo root:
  python3 scripts/jobspy/test_filters.py

No external dependencies — uses stdlib unittest only.
"""

import sys
import unittest
from pathlib import Path

# Allow importing scan.py without the optional jobspy / yaml runtime deps.
# We monkey-patch them before the import so the module-level try/except blocks
# don't abort the process.
import types

_yaml_stub = types.ModuleType("yaml")
_yaml_stub.safe_load = lambda *a, **kw: {}
_yaml_stub.__version__ = "stub"
sys.modules.setdefault("yaml", _yaml_stub)

_jobspy_stub = types.ModuleType("jobspy")
_jobspy_stub.scrape_jobs = lambda *a, **kw: None
sys.modules.setdefault("jobspy", _jobspy_stub)

# Now import the module under test (relative path from repo root).
_SCAN_PY = Path(__file__).parent / "scan.py"
import importlib.util as _ilu

_spec = _ilu.spec_from_file_location("scan", _SCAN_PY)
_scan = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_scan)  # type: ignore[union-attr]

build_title_filter = _scan.build_title_filter
build_lang_filter = _scan.build_lang_filter
is_allowed_location = _scan.is_allowed_location
keyword_matches = _scan.keyword_matches
derive_keywords_from_target_roles = _scan.derive_keywords_from_target_roles
make_company_role_key = _scan.make_company_role_key
_normalize_company = _scan._normalize_company
_normalize_title = _scan._normalize_title


# ── Word-boundary matching parity with scan-core.mjs ───────────────────────────
#
# The aggregator scanner (this file's scan.py) used to filter with raw
# `substring in title`, while the ATS scanner (scan-core.mjs) matches on WORD
# boundaries. Same portals.yml lists, two different results. These tests pin the
# corrected, identical-to-Node behavior so the divergence can't silently return.
# They mirror the headline cases in scripts/scan-core.test.mjs.

class TestKeywordMatches(unittest.TestCase):
    """keyword_matches — the word-boundary primitive (mirrors keywordMatches)."""

    def test_standalone_word_matches_anywhere(self):
        self.assertTrue(keyword_matches("Operations Lead", "Lead"))
        self.assertTrue(keyword_matches("Lead, Strategy", "Lead"))
        self.assertTrue(keyword_matches("Engineering Lead Role", "Lead"))
        self.assertTrue(keyword_matches("Lead", "Lead"))

    def test_does_not_match_inside_another_word(self):
        # The substring matcher killed these "Lead"-bearing junior titles.
        self.assertFalse(keyword_matches("Leadership Analyst", "Lead"))
        self.assertFalse(keyword_matches("Leading Indicators PM", "Lead"))
        self.assertFalse(keyword_matches("Ambitious Analyst", "BI"))
        self.assertFalse(keyword_matches("Synopsys Engineer", "Ops"))

    def test_case_insensitive(self):
        self.assertTrue(keyword_matches("SENIOR ANALYST", "senior"))
        self.assertTrue(keyword_matches("senior analyst", "Senior"))

    def test_trailing_leading_spaces_trimmed(self):
        # Legacy portals.yml wrote "Lead " / "Senior " with trailing spaces.
        self.assertTrue(keyword_matches("Operations Lead", "Lead "))
        self.assertTrue(keyword_matches("Senior Analyst", " Senior"))

    def test_punctuation_is_a_boundary(self):
        self.assertTrue(keyword_matches("R&D Analyst", "R&D"))
        self.assertTrue(keyword_matches("Pre-Sales Engineer", "Pre-Sales"))
        self.assertTrue(keyword_matches("Sales Manager (m/w/d)", "(m/w/d)"))

    def test_multiword_phrase_whitespace_tolerant(self):
        self.assertTrue(
            keyword_matches("Strategy & Operations Associate", "Strategy & Operations")
        )
        self.assertTrue(keyword_matches("Head  of   Growth", "Head of"))
        self.assertFalse(keyword_matches("Heads of State", "Head of"))

    def test_empty_inputs_safe(self):
        self.assertFalse(keyword_matches("", "Lead"))
        self.assertFalse(keyword_matches("Lead", ""))
        self.assertFalse(keyword_matches("Lead", "   "))


class TestTitleFilterWordBoundary(unittest.TestCase):
    """build_title_filter regressions for the substring → word-boundary fix."""

    def test_substring_negatives_no_longer_drop_good_juniors(self):
        f = build_title_filter(
            ["Analyst", "Operations", "Strategy"],
            ["Lead", "Senior", "VP", "Manager"],
        )
        # All wrongly DROPPED under substring matching; must pass now.
        self.assertTrue(f("Leadership Operations Analyst"))
        self.assertTrue(f("Leading Strategy Analyst"))
        # And genuine seniorities still drop.
        self.assertFalse(f("Operations Lead"))
        self.assertFalse(f("Senior Strategy Analyst"))

    def test_substring_positives_no_longer_keep_junk(self):
        f = build_title_filter(["Ops", "BI"], [])
        # Wrongly KEPT under substring matching ("ops" in "synopsys", "bi" in
        # "ambitious"); must drop now (no real positive word present).
        self.assertFalse(f("Synopsys Hardware Engineer"))
        self.assertFalse(f("Ambitious Designer"))
        # A real "Ops" / "BI" word still passes.
        self.assertTrue(f("Ops Analyst"))
        self.assertTrue(f("BI Developer"))


class TestLangFilterWordBoundary(unittest.TestCase):
    """build_lang_filter regression: a FR/NL token must not nuke English words."""

    def test_stage_token_does_not_kill_staged(self):
        f = build_lang_filter(["stage"])
        self.assertTrue(f("Staged Rollout Manager"))
        self.assertTrue(f("Backstage Operations"))
        # The real French/Dutch token still blocks.
        self.assertFalse(f("Stage Marketing Paris"))


class TestLocationWordBoundary(unittest.TestCase):
    """is_allowed_location regressions + Node allowlist parity."""

    def test_rome_does_not_match_jerome(self):
        self.assertFalse(is_allowed_location("Jerome, AZ, USA"))
        self.assertTrue(is_allowed_location("Rome, Italy"))

    def test_uk_word_boundary_without_bespoke_regex(self):
        self.assertTrue(is_allowed_location("London, UK"))
        self.assertTrue(is_allowed_location("UK"))
        self.assertFalse(is_allowed_location("Fukuoka, Japan"))
        self.assertFalse(is_allowed_location("Duke University Campus"))

    def test_node_parity_cities_now_accepted(self):
        # These EU hubs are in scan-core.mjs's allowlist but were missing here,
        # so the aggregator silently rejected them. Now at parity.
        for loc in [
            "Milano, Italy", "Valencia, Spain", "Manchester, UK",
            "Cambridge, UK", "Porto, Portugal", "Warsaw, Poland",
            "Krakow, Poland", "Eindhoven, Netherlands", "The Hague, Netherlands",
            "Cologne, Germany", "München, Germany", "Zürich, Switzerland",
        ]:
            self.assertTrue(is_allowed_location(loc), loc)


# ── Title filter ─────────────────────────────────────────────────────────────

class TestTitleFilter(unittest.TestCase):
    """Tests for build_title_filter — positive/negative keyword matching."""

    _POS = [
        "Analyst", "Analytics", "Strategy", "Operations", "Ops",
        "Consultant", "Consulting", "Advisory", "Solutions Consultant",
        "Graduate", "Intern", "Internship", "Trainee", "Early Career",
        "Working Student", "Werkstudent", "Stage", "Práctica",
        "Transformation", "Process", "Value Engineer",
    ]
    _NEG = [
        "Senior", "Sr", "Sr.", "(Senior)", "Lead", "Manager",
        "Senior Manager", "Director", "VP", "Vice President", "Head of",
        "Principal", "Staff", "Chief",
        "Software Engineer", "Backend Engineer", "Frontend Engineer",
        "Full Stack", ".NET", "Java", "iOS", "Android", "PHP", "Ruby",
        "DevOps", "SRE", "Infrastructure Engineer",
        "Compliance", "AML", "Fraud", "Legal", "Accounting", "Payroll",
        "Audit", "Tax", "Cyber", "SAP", "Forensic",
        "Enterprise",
        "Finance Intern", "Corporate Finance", "M&A", "Due Diligence",
    ]

    def setUp(self):
        self.f = build_title_filter(self._POS, self._NEG)

    # ── Should pass ──────────────────────────────────────────────────────

    def test_graduate_analyst(self):
        self.assertTrue(self.f("Graduate Analyst"))

    def test_business_analyst(self):
        self.assertTrue(self.f("Business Analyst"))

    def test_junior_strategy_consultant(self):
        self.assertTrue(self.f("Junior Strategy Consultant"))

    def test_intern_analytics(self):
        self.assertTrue(self.f("Analytics Intern"))

    def test_working_student(self):
        self.assertTrue(self.f("Working Student - Operations"))

    def test_early_career_program(self):
        self.assertTrue(self.f("Early Career Program — Strategy"))

    def test_stage_internship(self):
        """'Stage' (French for internship) is a positive keyword."""
        self.assertTrue(self.f("Stage Analyst"))

    def test_process_mining_consultant(self):
        self.assertTrue(self.f("Process Mining Consultant"))

    def test_marketing_analyst(self):
        """Marketing prefix doesn't appear in either list — passes if Analyst matches."""
        self.assertTrue(self.f("Marketing Analyst"))

    def test_revenue_operations_analyst(self):
        self.assertTrue(self.f("Revenue Operations Analyst"))

    # ── Should be rejected ───────────────────────────────────────────────

    def test_senior_analyst_rejected(self):
        self.assertFalse(self.f("Senior Business Analyst"))

    def test_director_rejected(self):
        self.assertFalse(self.f("Strategy Director"))

    def test_software_engineer_rejected(self):
        self.assertFalse(self.f("Software Engineer"))

    def test_account_manager_rejected(self):
        """'Manager' is negative even with 'Account' prefix."""
        self.assertFalse(self.f("Account Manager"))

    def test_stage_manager_rejected(self):
        """'Stage' is positive but 'Manager' is negative — negative wins."""
        self.assertFalse(self.f("Stage Manager"))

    def test_enterprise_analyst_rejected(self):
        """'Enterprise' is negative."""
        self.assertFalse(self.f("Sales Analyst - Enterprise"))
        self.assertFalse(self.f("Enterprise Account Executive"))

    def test_sr_dot_rejected(self):
        self.assertFalse(self.f("Sr. Business Analyst"))

    def test_lead_rejected(self):
        self.assertFalse(self.f("Lead Analyst Copenhagen"))

    def test_finance_intern_rejected(self):
        """'Finance Intern' composite is negative."""
        # The composite 'finance intern' is in negative list, but the title
        # 'Finance Intern' only triggers if 'finance intern' is a substring.
        # Note: "Finance Analyst Intern" should NOT be rejected because
        # "finance intern" is not a substring.
        self.assertFalse(self.f("Finance Intern"))

    def test_corporate_finance_rejected(self):
        self.assertFalse(self.f("Corporate Finance Analyst"))

    def test_no_positive_match_rejected(self):
        self.assertFalse(self.f("Graphic Designer"))
        self.assertFalse(self.f("Sous Chef"))
        self.assertFalse(self.f("Physician"))

    def test_empty_title_rejected(self):
        self.assertFalse(self.f(""))
        self.assertFalse(self.f(None))

    # ── No positive list → accept all (unless negative) ─────────────────

    def test_no_positive_list_accepts_any(self):
        f_no_pos = build_title_filter([], ["Senior"])
        self.assertTrue(f_no_pos("Graphic Designer"))
        self.assertFalse(f_no_pos("Senior Graphic Designer"))


# ── Language filter ───────────────────────────────────────────────────────────

class TestLangFilter(unittest.TestCase):
    """Tests for build_lang_filter — language blocklist token matching."""

    _BLOCKLIST = [
        "consultoría", "prácticas", "práctica", "becas", "recién",
        "werkstudent", "fiscaal", "fiscalist", "publieke", "financieel",
        "meeloopstage", "logistiek", "bliv", "revisorgraduate", "revisortrainee",
        "til", "mitarbeiter", "buchhaltung", "(w/m/d)", "(m/w/d)",
    ]

    def setUp(self):
        self.f = build_lang_filter(self._BLOCKLIST)

    def test_english_title_passes(self):
        self.assertTrue(self.f("Business Analyst"))
        self.assertTrue(self.f("Graduate Strategy Consultant"))

    def test_italian_title_passes(self):
        self.assertTrue(self.f("Analista di Business"))

    def test_german_gender_marker_blocked(self):
        self.assertFalse(self.f("Operations Analyst (m/w/d)"))
        self.assertFalse(self.f("Werkstudent Operations"))

    def test_dutch_token_blocked(self):
        self.assertFalse(self.f("Meeloopstage Analyst"))
        self.assertFalse(self.f("Logistiek Analyst"))

    def test_danish_token_blocked(self):
        self.assertFalse(self.f("Bliv Graduate"))

    def test_spanish_token_blocked(self):
        self.assertFalse(self.f("Consultoría Analista"))

    def test_empty_title_passes(self):
        self.assertTrue(self.f(""))
        self.assertTrue(self.f(None))

    def test_empty_blocklist_accepts_all(self):
        f_no_bl = build_lang_filter([])
        self.assertTrue(f_no_bl("Consultoría"))


# ── Location filter ───────────────────────────────────────────────────────────

class TestLocationFilter(unittest.TestCase):
    """Tests for is_allowed_location — EU city/country allowlist."""

    # ── Known-good EU locations ──────────────────────────────────────────

    def test_city_country_pair(self):
        self.assertTrue(is_allowed_location("Barcelona, Spain"))
        self.assertTrue(is_allowed_location("Madrid, Spain"))
        self.assertTrue(is_allowed_location("Dublin, Ireland"))
        self.assertTrue(is_allowed_location("Amsterdam, Netherlands"))
        self.assertTrue(is_allowed_location("Copenhagen, Denmark"))
        self.assertTrue(is_allowed_location("Vienna, Austria"))
        self.assertTrue(is_allowed_location("Zurich, Switzerland"))
        self.assertTrue(is_allowed_location("Stockholm, Sweden"))

    def test_city_only(self):
        self.assertTrue(is_allowed_location("London"))
        self.assertTrue(is_allowed_location("Paris"))
        self.assertTrue(is_allowed_location("Berlin"))
        self.assertTrue(is_allowed_location("Lisbon"))

    def test_hybrid_in_eu_city(self):
        self.assertTrue(is_allowed_location("Hybrid - London"))
        self.assertTrue(is_allowed_location("Munich (Hybrid)"))

    def test_united_kingdom(self):
        self.assertTrue(is_allowed_location("United Kingdom"))
        self.assertTrue(is_allowed_location("London, United Kingdom"))

    # ── UK bare abbreviation — previously broken ─────────────────────────

    def test_uk_bare_passes(self):
        """'UK' with no surrounding text must pass — was broken with the old ' uk' entry."""
        self.assertTrue(is_allowed_location("UK"))
        self.assertTrue(is_allowed_location("uk"))

    def test_uk_word_boundary_no_false_positives(self):
        """'duke', 'truck', 'bulk' must NOT match as UK."""
        # These cities are not in the allowlist, and contain 'uk' as a substring.
        self.assertFalse(is_allowed_location("Duke University Campus"))
        self.assertFalse(is_allowed_location("Fukuoka, Japan"))

    def test_uk_comma_format(self):
        """'UK, London' and 'London, UK' both pass."""
        self.assertTrue(is_allowed_location("London, UK"))
        self.assertTrue(is_allowed_location("UK, London"))

    # ── Europe / EMEA remote — new passthrough ───────────────────────────

    def test_europe_remote_passes(self):
        """EU-scoped remote strings should pass — EU companies use them."""
        self.assertTrue(is_allowed_location("Remote - Europe"))
        self.assertTrue(is_allowed_location("Europe (Remote)"))
        self.assertTrue(is_allowed_location("Europe"))

    def test_emea_remote_passes(self):
        self.assertTrue(is_allowed_location("EMEA"))
        self.assertTrue(is_allowed_location("Remote / EMEA"))

    # ── Empty / unknown → pass through ──────────────────────────────────

    def test_empty_passes(self):
        self.assertTrue(is_allowed_location(""))
        self.assertTrue(is_allowed_location(None))
        self.assertTrue(is_allowed_location("   "))

    # ── Non-EU locations → reject ────────────────────────────────────────

    def test_non_eu_rejected(self):
        self.assertFalse(is_allowed_location("New York, NY"))
        self.assertFalse(is_allowed_location("San Francisco, CA"))
        self.assertFalse(is_allowed_location("Toronto, Canada"))
        self.assertFalse(is_allowed_location("Singapore"))
        self.assertFalse(is_allowed_location("Sydney, Australia"))

    def test_bare_remote_passes_parity_with_node(self):
        """Bare 'Remote' now PASSES — parity with scan-core.mjs, whose
        DEFAULT_LOCATION_ALLOWLIST includes 'remote'. A remote posting that
        cleared the title/language gates is a legitimate keep (EU-remote roles
        routinely list just 'Remote'); the title filter is the real geography
        proxy. The aggregator previously rejected it, diverging from the ATS
        scanner on the same posting."""
        self.assertTrue(is_allowed_location("Remote"))


# ── Company / title normalization ─────────────────────────────────────────────

class TestNormalization(unittest.TestCase):
    """Tests for _normalize_company, _normalize_title, make_company_role_key."""

    # ── _normalize_company ───────────────────────────────────────────────

    def test_strips_inc(self):
        self.assertEqual(_normalize_company("Stripe, Inc."), "Stripe")
        self.assertEqual(_normalize_company("Stripe, Inc"), "Stripe")

    def test_strips_ltd(self):
        self.assertEqual(_normalize_company("Revolut Ltd."), "Revolut")

    def test_strips_gmbh(self):
        self.assertEqual(_normalize_company("SAP GmbH"), "SAP")

    def test_strips_bv(self):
        self.assertEqual(_normalize_company("ASML B.V."), "ASML")

    def test_no_suffix_unchanged(self):
        self.assertEqual(_normalize_company("Google"), "Google")
        self.assertEqual(_normalize_company("N26"), "N26")

    def test_strips_whitespace(self):
        self.assertEqual(_normalize_company("  Stripe  "), "Stripe")

    # ── _normalize_title ─────────────────────────────────────────────────

    def test_strips_city_suffix_dash(self):
        self.assertEqual(
            _normalize_title("Business Analyst - London"),
            "Business Analyst",
        )

    def test_strips_city_suffix_comma(self):
        self.assertEqual(
            _normalize_title("Operations Analyst, Amsterdam"),
            "Operations Analyst",
        )

    def test_strips_remote_suffix(self):
        self.assertEqual(
            _normalize_title("Strategy Consultant - Remote"),
            "Strategy Consultant",
        )

    def test_no_suffix_unchanged(self):
        self.assertEqual(
            _normalize_title("Graduate Business Analyst"),
            "Graduate Business Analyst",
        )

    # ── make_company_role_key ────────────────────────────────────────────

    def test_same_role_different_company_suffix(self):
        """Stripe vs Stripe, Inc. should produce the same dedup key."""
        k1 = make_company_role_key("Stripe", "Business Analyst")
        k2 = make_company_role_key("Stripe, Inc.", "Business Analyst")
        self.assertEqual(k1, k2)

    def test_same_role_different_city_suffix(self):
        """Same role posted for two cities deduplicates correctly."""
        k1 = make_company_role_key("Adyen", "Data Analyst - Amsterdam")
        k2 = make_company_role_key("Adyen", "Data Analyst - London")
        self.assertEqual(k1, k2)

    def test_different_roles_different_keys(self):
        k1 = make_company_role_key("Stripe", "Business Analyst")
        k2 = make_company_role_key("Stripe", "Operations Analyst")
        self.assertNotEqual(k1, k2)

    def test_different_companies_different_keys(self):
        k1 = make_company_role_key("Stripe", "Business Analyst")
        k2 = make_company_role_key("Adyen", "Business Analyst")
        self.assertNotEqual(k1, k2)

    def test_whitespace_normalised(self):
        k1 = make_company_role_key("  Stripe  ", "Business Analyst")
        k2 = make_company_role_key("Stripe", "Business Analyst")
        self.assertEqual(k1, k2)

    def test_case_insensitive(self):
        k1 = make_company_role_key("Stripe", "Business Analyst")
        k2 = make_company_role_key("STRIPE", "BUSINESS ANALYST")
        self.assertEqual(k1, k2)


# ── Keyword derivation ────────────────────────────────────────────────────────

class TestDeriveKeywords(unittest.TestCase):
    """Tests for derive_keywords_from_target_roles."""

    def test_simple_role(self):
        self.assertEqual(
            derive_keywords_from_target_roles(["Business Analyst"]),
            ["Business Analyst"],
        )

    def test_slash_split(self):
        result = derive_keywords_from_target_roles(["Tech Sales / Solutions Consultant"])
        self.assertIn("Tech Sales", result)
        self.assertIn("Solutions Consultant", result)

    def test_parenthetical_stripped(self):
        result = derive_keywords_from_target_roles(["Business Analyst (Tech)"])
        self.assertEqual(result, ["Business Analyst"])

    def test_long_phrase_dropped(self):
        """Phrases longer than MAX_WORDS_PER_KEYWORD (4) are dropped."""
        result = derive_keywords_from_target_roles([
            "Rotational / Early Careers / Graduate / Leadership Development Program"
        ])
        self.assertIn("Rotational", result)
        self.assertIn("Early Careers", result)
        self.assertIn("Graduate", result)
        # "Leadership Development Program" is 3 words — should be kept
        self.assertIn("Leadership Development Program", result)

    def test_dedup_case_insensitive(self):
        result = derive_keywords_from_target_roles(["Analyst / analyst / ANALYST"])
        self.assertEqual(len(result), 1)

    def test_empty_input(self):
        self.assertEqual(derive_keywords_from_target_roles([]), [])
        self.assertEqual(derive_keywords_from_target_roles(None), [])

    def test_em_dash_split(self):
        result = derive_keywords_from_target_roles(["Strategy—Operations"])
        self.assertIn("Strategy", result)
        self.assertIn("Operations", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
