// Pure mapping between deactivatable features (Settings › General › Features)
// and the UI surfaces they gate. Everything here is value-in / value-out so the
// gating rules are unit-testable without React or the stores.
//
// Only whole sidebar views need a map entry — sub-tabs, panels, and columns are
// gated inline at their render site by reading the flag directly.

import type { FeatureId, FeaturePrefs } from '@/types'
import type { ViewId } from '@/store/nav'

/** Views whose entire sidebar tab is feature-gated. Views absent from this map
 *  are permanent and always visible. */
export const VIEW_FEATURE: Partial<Record<ViewId, FeatureId>> = {
  today:    'todayView',
  outreach: 'outreachView',
  offers:   'offersView',
}

export function isViewEnabled(view: ViewId, features: FeaturePrefs): boolean {
  const flag = VIEW_FEATURE[view]
  return flag === undefined || features[flag]
}

/** Where navigation lands when it targets a deactivated view — the Scouting
 *  cockpit, the app's permanent home surface. */
export const FALLBACK_VIEW: ViewId = 'scouting'

/** Resolve a navigation target against the active feature set: enabled views
 *  pass through, deactivated ones fall back to the cockpit. Keeps stray deep
 *  links (shortcuts, cross-view buttons, restored state) harmless. */
export function resolveView(view: ViewId, features: FeaturePrefs): ViewId {
  return isViewEnabled(view, features) ? view : FALLBACK_VIEW
}
