/**
 * What unikeys is allowed to report about itself, and nothing else.
 *
 * unikeys reads other people's config files. Its whole claim is that opening it
 * writes nothing and takes nothing, so analytics that leaked a config path, a
 * vault name or a chord someone typed would break a bigger promise than any
 * failed write. That risk is handled here, by construction, in three layers:
 *
 * 1. `AnalyticsEvent` is a closed union. A call site cannot invent an event name
 *    and cannot attach a property the event does not declare — excess property
 *    checking rejects the object literal at the call site.
 * 2. `EVENT_PROPERTIES` repeats the same shape at runtime, and `sanitize()`
 *    drops anything not on it. Belt and braces: a value that reached a payload
 *    through an `as` cast or a spread still never leaves the machine.
 * 3. Every property type below is an enum, a boolean or a number. There is
 *    exactly one string-shaped field, `action_id`, and it carries a catalogue id
 *    that unikeys itself ships.
 *
 * NEVER add a property carrying any of these, whatever the justification:
 *
 *   - absolute or relative filesystem paths, including `configPath` overrides,
 *     `grantPath`, the backup directory and anything derived from `$HOME`
 *   - the contents of any config file, or any fragment of one
 *   - Obsidian vault names (they are folder names, and people name folders after
 *     clients, employers and projects under NDA)
 *   - chord strings the user authored, or any keystroke capture
 *   - machine name, username, or the macOS serial
 *   - error messages from the file layer — they embed paths as a matter of course
 *
 * Counts of the above are fine. The things themselves never are.
 *
 * Pure, and deliberately in `src/shared/`: main sends these, the renderer builds
 * them, and both must agree on the shape by construction rather than by comment.
 */

import type { AppId } from './apps'

/**
 * Which build is reporting. The App Store build cannot currently reach the
 * network at all — `build/entitlements.mas.plist` has no `network.client` — so
 * in practice this is always `dmg` today. It exists so that the day that
 * changes, historical data is still separable by channel rather than silently
 * merging two populations that behave nothing alike.
 */
export type Channel = 'dmg' | 'mas'

/** The onboarding wizard's steps, mirroring `Step` in `OnboardingWizard.tsx`. */
export type OnboardingStep = 'consent' | 'pick' | 'access' | 'results'

/**
 * The outcome of asking for a folder, flattened from `GrantOutcome` to its
 * discriminant alone. The `error` string is deliberately not carried: those
 * messages come from the file layer and name paths.
 */
export type GrantOutcomeKind = 'granted' | 'cancelled' | 'error'

/**
 * Attached to every event by `src/main/analytics.ts`, not by any call site.
 *
 * It lives there because only main can read it, and it is ambient rather than
 * per-event so that any event can be broken down by build or by OS without
 * every call site having to remember to say so. Listed here as documentation of
 * what actually ships alongside the properties below — these names are not
 * available to a call site and must not be repeated in an event's own
 * properties, or the event would declare a field it never fills.
 */
export interface AmbientContext {
  channel: Channel
  app_version: string
  /** macOS major version only — `26`, not `26.1.2`. */
  os_version: string
  sandboxed: boolean
  /**
   * Displaces the IP address PostHog's ingestion would otherwise record off the
   * request. Always the placeholder — see the comment where it is set for why
   * it cannot be `null`.
   */
  $ip: string
}

export type AnalyticsEvent =
  | { name: 'app_launched'; properties: { apps_enabled_count: number } }
  | { name: 'onboarding_started'; properties?: undefined }
  | { name: 'onboarding_step_completed'; properties: { step: OnboardingStep } }
  | {
      name: 'onboarding_completed'
      properties: { apps_selected_count: number; apps_granted_count: number }
    }
  | { name: 'onboarding_dismissed'; properties: { at_step: OnboardingStep } }
  | { name: 'grant_outcome'; properties: { app: AppId; outcome: GrantOutcomeKind } }
  | {
      name: 'bindings_imported'
      properties: {
        apps_read: number
        apps_failed: number
        actions_found: number
        /** Rows where the apps that bind the action do not agree. */
        rows_diverging: number
      }
    }
  | {
      name: 'row_matched'
      properties: {
        /** A shipped catalogue id, not anything the user authored. */
        action_id: string
        /**
         * Whether the apps disagreed badly enough that unikeys had to ask which
         * chord wins, rather than settling the row on its own.
         *
         * Deliberately not a count of the cells the match wrote: which cells a
         * match writes is the table reducer's rule and lives there and nowhere
         * else, so computing it at this call site would be a second copy of it —
         * one that could drift and would be believed anyway.
         */
        needed_winner: boolean
      }
    }
  | {
      name: 'save_completed'
      properties: {
        apps_written: number
        apps_failed: number
        bindings_written: number
        bindings_skipped: number
        bindings_dropped: number
      }
    }
  | { name: 'save_reverted'; properties: { apps_count: number } }
  | { name: 'app_toggled'; properties: { app: AppId; enabled: boolean } }
  | { name: 'analytics_opt_in'; properties?: undefined }
  | { name: 'analytics_opt_out'; properties?: undefined }

export type AnalyticsEventName = AnalyticsEvent['name']

/**
 * The same contract as `AnalyticsEvent`, at runtime.
 *
 * The mapped type is what keeps the two from drifting: adding an event to the
 * union without adding it here is a compile error, and so is naming a property
 * that its event does not declare. What it cannot catch is an event listing
 * *fewer* keys than it declares — `analytics.test.ts` covers that direction.
 */
export const EVENT_PROPERTIES: {
  [Name in AnalyticsEventName]: ReadonlyArray<
    keyof Extract<AnalyticsEvent, { name: Name }>['properties']
  >
} = {
  app_launched: ['apps_enabled_count'],
  onboarding_started: [],
  onboarding_step_completed: ['step'],
  onboarding_completed: ['apps_selected_count', 'apps_granted_count'],
  onboarding_dismissed: ['at_step'],
  grant_outcome: ['app', 'outcome'],
  bindings_imported: ['apps_read', 'apps_failed', 'actions_found', 'rows_diverging'],
  row_matched: ['action_id', 'needed_winner'],
  save_completed: [
    'apps_written',
    'apps_failed',
    'bindings_written',
    'bindings_skipped',
    'bindings_dropped'
  ],
  save_reverted: ['apps_count'],
  app_toggled: ['app', 'enabled'],
  analytics_opt_in: [],
  analytics_opt_out: []
}

export const ANALYTICS_EVENT_NAMES = Object.keys(EVENT_PROPERTIES) as AnalyticsEventName[]

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EVENT_PROPERTIES, value)
}

/**
 * The payload as it will actually be sent: declared properties only.
 *
 * The last thing between a call site and the network, and the reason it exists
 * is that the type system stops at the process boundary. An event arriving over
 * IPC is `unknown` no matter how well typed the renderer was — a renderer built
 * from stale code, or a call site that cast to get past a compile error, both
 * produce a well-formed message carrying a key nothing here declared. Copying
 * the allowed keys across, rather than deleting the unwanted ones, means the
 * failure mode of that is a missing property rather than a leaked one.
 *
 * Returns `null` for an event name that is not in the contract at all, so an
 * unrecognised message is dropped rather than forwarded verbatim.
 */
export function sanitize(event: {
  name: string
  properties?: Record<string, unknown>
}): { name: AnalyticsEventName; properties: Record<string, unknown> } | null {
  if (!isAnalyticsEventName(event.name)) return null
  const allowed = EVENT_PROPERTIES[event.name] as ReadonlyArray<string>
  const properties: Record<string, unknown> = {}
  for (const key of allowed) {
    const value = event.properties?.[key]
    if (value !== undefined) properties[key] = value
  }
  return { name: event.name, properties }
}
