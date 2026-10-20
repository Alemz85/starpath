# Customization Guide

## Profile (user/profile.yml)

This is the single source of truth for your identity. All modes read from here.

Key sections:
- **candidate**: Name, email, phone, location, LinkedIn, portfolio
- **target_roles**: Your North Star roles and archetypes
- **narrative**: Your headline, exit story, superpowers, proof points
- **compensation**: Target range, minimum, currency
- **location**: Country, timezone, visa status, on-site availability

## Target Roles (user/_profile.md)

The archetype table in `_profile.md` determines how offers are scored and CVs are framed. Edit the table to match YOUR career targets:

```markdown
| Archetype | Thematic axes | What they buy |
|-----------|---------------|---------------|
| **Your Role 1** | key skills | what they need |
| **Your Role 2** | key skills | what they need |
```

Also update the "Adaptive Framing" table to map YOUR specific projects to each archetype.

## Portals (user/portals.yml)

Copy from `templates/user-examples/portals.yml` and customize:

1. **title_filter.positive**: Keywords matching your target roles
2. **title_filter.negative**: Tech stacks or domains to exclude
3. **search_queries**: WebSearch queries for job boards (Ashby, Greenhouse, Lever)
4. **tracked_companies**: Companies to check directly

## CV Template (templates/cv-template.html)

The HTML template uses these design tokens:
- **Fonts**: Space Grotesk (headings) + DM Sans (body) -- self-hosted in `fonts/`
- **Colors**: Cyan primary (`hsl(187,74%,32%)`) + Purple accent (`hsl(270,70%,45%)`)
- **Layout**: Single-column, ATS-optimized

To use your own design, copy the template to `private/overrides/templates/cv-template.html` and edit the CSS there (the public default stays untouched). Add font files to `fonts/` if switching fonts.

## Negotiation Scripts (user/_profile.md)

`modes/_shared.md` ships generic negotiation frameworks. Put your own in `user/_profile.md` (read after `_shared.md`, so it wins):
- Target ranges
- Geographic arbitrage strategy
- Pushback responses

## Your own version of a system file (private/overrides/)

Anything in `modes/`, `batch/batch-prompt.md`, `templates/` or `config/profile.example.yml` can be made yours without touching the public default:

- `private/overrides/<same path>` replaces the file, e.g. `private/overrides/templates/cv-template.html` for your own CV design or `private/overrides/modes/contacto.md` for your outreach style.
- `private/overrides/<path minus .md>.append.md` adds to it, e.g. `private/overrides/modes/_shared.append.md` for worked examples that use your real schools and target companies.

Write them as specific as you like: `private/` never enters the public repo. `npm run overrides` lists what is active and warns when the default changed after your copy.

## Hooks (Optional)

The repo ships one Claude Code hook in `.claude/settings.json`: at session start it prints your active overrides (`npm run overrides -- --brief`). Add your own the same way, e.g.:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "echo 'Career-ops session started'"
      }]
    }]
  }
}
```

Save hooks in `.claude/settings.json`.

## States (templates/states.yml)

The canonical states rarely need changing. If you add new states, update:
1. `templates/states.yml`
2. `scripts/normalize-statuses.mjs` (alias mappings)
3. `modes/_shared.md` (any references)
