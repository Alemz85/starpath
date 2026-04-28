# User-file templates

Blank versions of the five files that live under `user/` once a workspace is set up. Use these in either of two ways.

## Path A — Using the Starpath desktop app

You don't need these templates. The onboarding wizard walks you through filling them in (paste your CV → fill in profile → configure portals), then auto-generates `user/_profile.md` from your CV via the `career-ops-setup` Claude skill. The wizard is the path of least resistance.

## Path B — Filling these manually with Claude chat (no desktop app)

If you'd rather work in [claude.ai](https://claude.ai) without the desktop app:

1. Copy the templates into `user/`:
   ```bash
   cp templates/user-examples/cv.md          user/cv.md
   cp templates/user-examples/profile.yml    user/profile.yml
   cp templates/user-examples/portals.yml    user/portals.yml
   cp templates/user-examples/_profile.md    user/_profile.md       # optional
   cp templates/user-examples/article-digest.md user/article-digest.md  # optional
   ```

2. Open [claude.ai](https://claude.ai) and attach (or paste) your CV + the four user files above. Tell Claude:

   > Help me fill out these files for my job-search workspace.
   > - cv.md → adapt the structure to my actual experience
   > - profile.yml → fill in identity, target roles, comp range, location, dream companies
   > - _profile.md → write the narrative, archetypes, exit story, proof points based on my CV
   > - portals.yml → tailor positive/negative keywords to my target roles, suggest 5-10 companies to track

3. Save the responses back into the `user/` folder. Open the workspace in the desktop app later if you want a GUI.

## What each file does

| File | Purpose | Auto-tailorable? |
|------|---------|---|
| `cv.md` | Source CV — every evaluation reads this for Skills Match anchoring. Markdown, human-edited. | No (your CV, your voice) |
| `profile.yml` | Structured profile data: identity, target archetypes, dream companies, comp range, location, languages. The single source of truth for everything structured. | Partially — the Configuration tab in the app edits this directly with structured forms. |
| `_profile.md` | Narrative candidate-context the AI reads before scoring: archetypes table, dream companies, exit narrative, negotiation scripts, location policy, proof points, scoring calibration. | **Yes** — the `career-ops-setup` skill (run during onboarding and on every Save in the Configuration tab) reads `cv.md` + `profile.yml` and generates / updates this. |
| `portals.yml` | Title-keyword filters and tracked-company configs for the portal scanner. | Partially — the setup skill writes the keyword lists; the app's Add Company flow probes ATS APIs and writes individual company entries. |
| `article-digest.md` | Optional. Detailed write-ups of your most impactful projects / articles / talks for grounding STAR stories during oferta evaluations. | No — these are your projects, you write them. |

## What gets read by which mode

- Every mode (`scouting`, `oferta`, `pipeline`, `pdf`, etc.) reads `cv.md`, `profile.yml`, and `_profile.md` before scoring.
- `scan` and `pipeline` read `portals.yml` for the title filters and tracked-company list.
- `oferta` and `pdf` (CV tailoring) read `article-digest.md` when present for proof points.

## After you've filled them in

Drop the files into `user/`, point the desktop app at the folder, and the cache will pick them up. Or use the markdown / YAML directly with the `claude` CLI: `claude -p '/career-ops scouting' < some-jd.txt` will read them at evaluation time.
