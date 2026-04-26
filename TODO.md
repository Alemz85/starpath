# career-ops TODO

---

## batch-prompt.md drift

- [ ] Add check to `modes/batch.md`: before launching workers, compare version header in `_shared.md` vs declared version in `batch-prompt.md`. Warn and refuse if mismatched.
- [ ] Investigate whether `claude -p` supports `--include-file` so `batch-prompt.md` can reference `_shared.md` by path instead of duplicating it.

---


---

# ══════════════════════════════════════════
# FRONTEND
# ══════════════════════════════════════════

Electron + Next.js desktop app. MVP built and packaged as DMG (arm64 + x64). Pending: user testing to confirm all views work end-to-end.

---

## Open / remaining work

### Onboarding
- [ ] Portals step: custom company add (URL + scan method) — not yet built
- [ ] `claude -p` calls: currently spinner only, no streaming output to UI

### Scan view
- [ ] Auto-trigger `merge-tracker.mjs` / `merge-scouting.mjs` after scan completes
- [ ] Parse and display badge count of new entries found

### Pipeline
- [ ] One-click status update from kanban (currently read-only)
- [ ] Click company name in any view → navigate to company detail

### Data
- [ ] File watcher: auto-refresh when TSVs change on disk (currently manual only)

---

## Known bugs

- [ ] Onboarding folder picker: dialog unreliable — added "Type path manually" fallback, needs user testing
- [ ] Scan view: does not auto-trigger merge scripts after scan

---

## Post-MVP views (no commitment)

- **Negotiation tracker** — track offer negotiation rounds, counter-offers, deadlines
- **Interview prep viewer** — read `interview-prep/*.md`, render with story bank inline
- **Story bank browser** — STAR+R stories, tag by theme, mark as used
- **CV diff viewer** — compare two generated PDF versions
- **Outreach tracker** — LinkedIn contact attempts from reports

---

## Packaging (((Much later)))

- [ ] Notarization — requires Apple Developer account ($99/yr). Without it, users right-click → Open to bypass Gatekeeper.
- [ ] Windows support — Mac-only for now.
- [ ] **Self-contained install (v2):** Bundle system files inside app, extract to `~/Library/Application Support/career-ops/` on first launch — users never clone a repo. Don't do while in active daily use — breaking change to dev workflow.
