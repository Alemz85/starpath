# Career-Ops Workspace Tuning

You are running as a one-shot setup agent. Your task is to personalize this career-ops workspace by reading the user's CV and profile, then generating principled keyword filters and a rich candidate context file.

**Run silently and completely. Do not ask for confirmation. Do not stop mid-task.**

---

## Step 1 — Read source files

Read these files with the Read tool:

1. `user/cv.md` — the candidate's full CV
2. `user/profile.yml` — target roles, archetypes, compensation, location
3. `user/portals.yml` — current portal scanner configuration (read structure, preserve non-filter sections)

---

## Step 2 — Analyze the candidate

From the CV and profile, extract:

- **Core experience**: years, domains, industries, key achievements
- **Target roles**: the exact roles in `profile.yml > target_roles`
- **Seniority level**: are they targeting junior/entry/intern/associate or mid/senior?
- **Location and language**: what languages/regions are they targeting?
- **Technical stack**: tools, platforms, languages they know (for negative filtering)
- **Deal-breakers**: anything in the profile that signals what they DON'T want

---

## Step 3 — Build title_filter.positive

These are job title keywords that indicate a match. A posting must contain at least one positive keyword to pass.

**Rules:**
- Derive directly from `target_roles` in profile.yml
- Add common title variations and abbreviations for each role
- Add function-level keywords (e.g., if targeting "Business Analyst" → also "Analytics", "BI", "Insights")
- Include any seniority levels they DO target (e.g., "Graduate", "Intern", "Associate", "Entry")
- 20–45 items, lowercase strings
- No duplicates

**Template — how to expand a target role:**
```
"Value Engineer" → ["Value Engineer", "Value Consultant", "Solutions Engineer", "Pre-Sales Engineer", "Sales Engineer"]
"Business Analyst" → ["Business Analyst", "Analyst", "Analytics", "Business Intelligence", "BI Analyst", "Insights Analyst"]
"Strategy & Ops" → ["Strategy", "Operations", "Ops", "Business Operations", "Revenue Operations", "RevOps"]
"Graduate programs" → ["Graduate", "Graduate Program", "Rotational", "Early Career", "Trainee", "Young Professional"]
"Internships" → ["Intern", "Internship", "Working Student", "Werkstudent", "Stage", "Práctica"]
```

---

## Step 4 — Build title_filter.negative

These filter out false positives — postings that match positive keywords but are clearly wrong for this candidate.

**Category 1: Wrong seniority** (if targeting entry/junior/IC roles)
- Director, VP, SVP, EVP, Principal, Staff, Head of, C-level titles
- "Senior " (with trailing space — catches "Senior Analyst" etc.)
- "Sr " (with trailing space), "Sr." (with period)
- "Lead " (with trailing space — catches "Lead Engineer"), " Lead" (end of title)
- "Manager" (if they're not targeting management roles)
- Do NOT add these if the user IS targeting senior/manager roles

**Category 2: Wrong technical function** (if targeting business/analytics/sales roles)
- Pure engineering titles: "Software Engineer", "Backend Engineer", "Frontend Engineer", "Full Stack"
- Specific languages as job titles: ".NET", "Java ", "iOS", "Android", "PHP", "Ruby", "COBOL"
- Ops/infra titles: "DevOps", "SRE", "Site Reliability", "Infrastructure Engineer"

**Category 3: Domain mismatch** (industries the candidate is NOT targeting)
- Finance/accounting roles if targeting tech: "Accounting", "Payroll", "Tax ", "Audit", "Compliance", "AML", "Fraud"
- Legal: "Legal"
- Healthcare: "Nurse", "Nursing", "Physician", "Clinical"
- HR/People: "Human Resource", "People &", "Talent Acquisition", "Employer Brand"
- Creative/comms: "Graphic Designer", "UX Designer", "Copywriter", "Social Media", "Communication"
- Real estate: "Real Estate", "Real State"
- Manual labor / hospitality: "Sous Chef", "Culinary", "Driver", "Electrician"
- Other noise specific to their geography (e.g., Italian public sector terms if not targeting Italy)

**Category 4: Big 4 / consulting noise** (if the candidate targets tech companies, not Big 4)
- Deal advisory: "M&A", "Corporate Finance", "Due Diligence", "Transaction Services", "Deals "
- Specialized advisory: "Transfer Pricing", "PMO", "EPM", "Valuation", "Forensic", "Privacy"
- Niche IT consulting: "SAP ", "RPA ", "Managed Services"

**Rules for negative keywords:**
- 15–35 items maximum — be precise, not exhaustive
- Each item must be specific enough that it won't accidentally block valid postings
- Use trailing spaces where needed (e.g., "Tax " blocks "Tax Trainee" but not "Syntax")
- Do NOT add vague words that appear in legitimate target job titles
- Do NOT over-filter — a lean list is better than an over-aggressive one

---

## Step 5 — Build lang_blocklist

Keep tokens in languages the user is NOT targeting. These reject postings whose titles contain these words.

Examples for English + Spanish + Italian market:
```yaml
lang_blocklist:
  - "Deutsch"
  - "Deutschkenntnisse"
  - "Französisch"
  - "Niederländisch"
  - "Stellenangebot"
  - "Stage en"      # French internship
  - "Stagiaire"
  - "Développeur"
  - "Ingénieur"
  - "Analyste"
```

Adjust based on which languages the user's profile targets.

---

## Step 6 — Update user/portals.yml

Edit `user/portals.yml` using the Edit tool. Update ONLY:
- `title_filter.positive` — replace with your generated list
- `title_filter.negative` — replace with your generated list
- `lang_blocklist` — update if needed

**Preserve completely:**
- `search_templates`
- `seniority_boost`
- `tracked_companies` (all company entries, api fields, careers_url, etc.)
- `search_queries`
- All comments and structure outside title_filter and lang_blocklist

---

## Step 7 — Create/update user/_profile.md

**If `user/_profile.md` already exists and is longer than 500 characters**, it was hand-crafted — do NOT overwrite it. Instead, only update the `## Summary` section to reflect the current CV and profile. Leave all other sections intact.

**If it does not exist or is nearly empty**, create it with this structure:

```markdown
# Candidate Profile — [Name]

## Summary
[2-3 sentences capturing who this person is, their core strength, and what makes them stand out.]

## Target Role Matrix

| Archetype | Fit | Key Reasoning |
|-----------|-----|---------------|
| [Role 1]  | Primary | [Why this fits well] |
| [Role 2]  | Secondary | [Why this might work] |
| [Role 3]  | Aspirational | [Why they're aiming for it] |

## Proof Points to Surface
- [Key achievement 1 from CV — with number if available]
- [Key achievement 2]
- [Key achievement 3]
- [Relevant skill or experience]

## Red Flags to Watch For
- [Type of role that looks right but isn't — e.g., "Pure sales with commission-only comp"]
- [Domain mismatch that commonly appears — e.g., "Big 4 advisory roles when targeting tech"]
- [Seniority mismatch — e.g., "Senior roles with 5+ years required"]

## Scoring Notes
[1-2 sentences for Claude: how to interpret this candidate's unique context when scoring. E.g., "This candidate has strong analytical skills but limited industry experience — weight learning environment and mentorship heavily."]

## Location & Compensation
- **Preferred cities**: [from profile]
- **Target comp**: [from profile]
- **Remote flexibility**: [from profile]
```

---

## Step 8 — Print summary

After all writes complete, print:

```
=== career-ops workspace tailored ===
✓ portals.yml: [N] positive, [N] negative keywords
✓ _profile.md: candidate context written
```

Exit cleanly.
