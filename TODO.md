# starpath TODO

---

## Restore the Company detail view

**Context.** A `CompanyView` component exists at `frontend/src/components/company/CompanyView.tsx` and a route at `frontend/src/app/company/page.tsx`, but neither is reachable today. `frontend/src/app/layout.tsx` deliberately ignores its `children` prop (the `_children` underscore on line 10) and renders `<AppShell />` directly. AppShell decides what to show based on `useNavStore.view` (default: `'scouting'`), so all `<Link href="/{view}">` Next.js navigations under static export fall through to a full reload that resets the nav store and lands the user back on Scouting. That was the bug we just patched out of `OffersTable.tsx` and `ApplyingView.tsx` by replacing the company `<Link>`s with non-navigating elements.

**Goal.** Make clicking a company logo (or a future "View company" entry in the row popover) actually open the `CompanyView` panel inside the existing AppShell, the same way every other tab does.

**Recipe.**

1. **`frontend/src/store/nav.ts`** — extend the store:
   - Add `'company'` to the `ViewId` union.
   - Add `companySlug?: string` field on `NavState`.
   - Update `navigate(view, databaseFilter?, companySlug?)` to accept and persist the slug. Reset `companySlug` to `undefined` when navigating to anything other than `'company'`.

2. **`frontend/src/components/layout/AppShell.tsx`** — add the conditional render:
   ```tsx
   {view === 'company' && companySlug && <CompanyView slug={companySlug} />}
   ```
   Import `CompanyView` from `@/components/company/CompanyView`. Read `companySlug` from `useNavStore`.

3. **`frontend/src/components/shared/CompanyLink.tsx`** — replace the Next.js `<Link>` with a `<button>`:
   - Drop the `import Link from 'next/link'`.
   - On click, call `useNavStore.getState().navigate('company', '', toCompanySlug(company))`. Keep the `e.stopPropagation()` so it doesn't trigger row-popover handlers in OffersTable.
   - Once this exists, you can revert the inline `<CompanyLogo>` swaps in `OffersTable.tsx` and `ApplyingView.tsx` back to `<CompanyLink>` so the company name and logo become navigable again — they'll reach the proper Company view this time.

4. **`frontend/src/components/layout/Sidebar.tsx`** — optional. Don't add `'company'` to any of the `PRIMARY_NAV` / `SECONDARY_NAV` / `BOTTOM_ITEMS` arrays — Company isn't a top-level destination. The sidebar should still highlight whichever tab the user navigated *from* when on Company; if you want a back-affordance, add a "← back to {previous}" header to `CompanyView` itself rather than a sidebar entry.

5. **Static-export route file** at `frontend/src/app/company/page.tsx` — leave it alone. It exists so `next build` generates a deep-linkable `/company.html`, even if the renderer never actually loads it under normal AppShell-driven navigation. Removing it is fine too if you don't care about deep links.

6. **CONTEXT.md** — once shipped, update the view table in `CONTEXT.md` § "Views" to add the `company` row, and update the "Adding a new view" recipe note that says "Most views skip [the route file]" — Company is one of the few that has a meaningful `app/{view}/page.tsx`.

**Out-of-scope but adjacent.** The same broken-Link pattern probably exists in any other component that uses `<Link href="/{view}">`. Grep `frontend/src/components` for `Link href=` and audit each match the same way. Most are likely safe (icon links to external URLs) but anything pointing at an in-app route is dead.

---

## Other open work

(Nothing tracked here right now — add new items above this line as they come up.)
