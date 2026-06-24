# starpath TODO

---

## Other open work

(Nothing tracked here right now — add new items above this line as they come up.)

---

## Done

- **Restore the Company detail view** (2026-06-25). `CompanyView` is now reachable
  in-app: `nav.ts` gained a `company` view + `companySlug` + `companyReturnView`;
  `AppShell` renders it; `CompanyLink` and CmdK drive it via `navigate('company',
  '', slug)` instead of a full-reload `<Link>`/`router.push`; the Database table's
  company logo opens the dossier; the back button returns to the origin view. The
  broken in-app-`<Link>` pattern is fully gone — no `next/link` or `useRouter`
  remain in the renderer. View labels are single-sourced in `VIEW_LABELS`
  (`store/nav.ts`). Covered by `store/nav.test.ts`.
