/**
 * The only place unikeys talks to PostHog.
 *
 * Deliberately the main process, and deliberately `posthog-node` rather than
 * `posthog-js` in the renderer. The renderer's DOM holds app names, config
 * paths and the chords themselves; `posthog-js` autocapture records DOM text,
 * so pointing it at this renderer would ship exactly the data
 * `src/shared/analytics.ts` exists to keep off the wire — and it would be one
 * config flag away from doing so even with autocapture turned off. Keeping the
 * browser SDK out of the app entirely is also why project-wide session replay
 * can be left on for the landing page: there is no recorder in this process to
 * enable.
 *
 * Three other consequences of living here: no CSP to widen, no `localStorage`,
 * and one `distinct_id` owned by the process that owns the store.
 *
 * The token is a project *write* key, not a secret. It is meant to ship inside
 * client code, and `.env` files are excluded from the packaged asar by
 * `electron-builder.yml`, so there is nowhere else for it to live.
 */

import { app } from 'electron'
import { release } from 'node:os'
import { PostHog } from 'posthog-node'

import {
  sanitize,
  type AmbientContext,
  type AnalyticsEvent,
  type Channel
} from '../shared/analytics'
import { isSandboxed, isSimulatedSandbox } from './grants'

const PROJECT_TOKEN = 'phc_pUKGXqQXsFSsUeG3qRZrjjzrVP2RF4SF8LfmgyPPvqQs'
const HOST = 'https://us.i.posthog.com'

/**
 * The client, or `null` for "not sending".
 *
 * Null is the state before consent and after opting out, and the distinction
 * from a constructed-but-disabled client matters: there is no object holding a
 * queue, no timer, and nothing that a later code change could accidentally
 * flush. Opting out drops the client rather than muting it.
 */
let client: PostHog | null = null
let distinctId: string | null = null

/**
 * Set once the app has decided whether it may send. Until then `capture()`
 * drops everything — a race between an early event and the store finishing its
 * load must not resolve in favour of sending.
 */
let configured = false

/**
 * Whether this run may talk to PostHog at all, before consent even enters it.
 *
 * A development run is excluded so that working on unikeys does not pollute the
 * data the app is being changed on the strength of. `UNIKEYS_ANALYTICS_DEV=1`
 * overrides that, which is the only way to test the pipe end to end without a
 * packaged build.
 */
function permittedInThisRun(): boolean {
  if (process.env.UNIKEYS_ANALYTICS_DEV === '1') return true
  if (isSimulatedSandbox()) return false
  return app.isPackaged
}

function channel(): Channel {
  // `process.mas` is the real signal; the simulated sandbox is a dev flag and
  // is already excluded above, so it cannot make a dmg build report as `mas`.
  return process.mas === true ? 'mas' : 'dmg'
}

/** macOS major version only. `25.3.0` (Darwin) is macOS 26 — hence the +1. */
function osVersion(): string {
  const darwinMajor = Number.parseInt(release().split('.')[0] ?? '', 10)
  return Number.isFinite(darwinMajor) ? String(darwinMajor + 1) : 'unknown'
}

/**
 * Context attached to every event. Small on purpose: enough to tell an App
 * Store user from a dmg user and an old build from a new one, and nothing that
 * narrows towards a person.
 */
function context(): AmbientContext {
  return {
    channel: channel(),
    app_version: app.getVersion(),
    os_version: osVersion(),
    sandboxed: isSandboxed(),
    // Overwrites the IP address PostHog would otherwise record. Not a nicety:
    // the consent screen promises nothing identifying is sent, and an IP
    // identifies a household — under GDPR it is personal data outright. A
    // promise this app cannot keep would be worse than no analytics at all.
    //
    // A placeholder rather than `null`, and that is the whole trick. PostHog's
    // ingestion fills `$ip` in from the source address of the request unless
    // the event carries its own value, and `null` does not count as one — a
    // verification run sending `null` arrived with a real home IP attached.
    // Only a concrete value displaces it.
    $ip: '0.0.0.0'
  }
}

/**
 * Points the client at this installation's identity and consent state. Called
 * on load and again whenever the user changes their mind.
 */
export function configureAnalytics(id: string, enabled: boolean | null): void {
  configured = true
  distinctId = id
  if (enabled === true && permittedInThisRun()) {
    start()
  } else {
    void stop()
  }
}

function start(): void {
  if (client !== null) return
  try {
    // Constructed here rather than at module scope: importing `posthog-node`
    // starts nothing, but instantiating it starts a flush timer, and a build
    // that never consents must never have one.
    client = new PostHog(PROJECT_TOKEN, {
      host: HOST,
      // A desktop app can sit open for days, so a large batch would mean a
      // day-old event or none at all if the process dies. Ten events or thirty
      // seconds, whichever comes first, and `shutdown()` covers the rest.
      flushAt: 10,
      flushInterval: 30_000
    })
  } catch (error) {
    // Analytics failing must never be visible to the user, let alone fatal.
    client = null
    if (!app.isPackaged) console.error('[analytics] failed to start', error)
  }
}

async function stop(): Promise<void> {
  const current = client
  client = null
  if (current === null) return
  try {
    await current.shutdown()
  } catch {
    // Nothing to do and nothing to say: the process is either quitting or the
    // user just asked to stop being measured.
  }
}

/**
 * Records one event, if this installation has said yes.
 *
 * Never throws and never returns a rejected promise — a call site must be able
 * to fire one of these without a `catch`, because an analytics failure is not
 * something the user's save should care about.
 */
export function capture(event: AnalyticsEvent): void {
  if (!configured || client === null || distinctId === null) return
  // Sanitised even though the argument is typed, because the caller is across
  // an IPC boundary where types do not survive. See `sanitize`.
  const clean = sanitize(event)
  if (clean === null) return
  try {
    client.capture({
      distinctId,
      event: clean.name,
      properties: { ...context(), ...clean.properties }
    })
  } catch (error) {
    if (!app.isPackaged) console.error('[analytics] capture failed', error)
  }
}

/**
 * Turns reporting on or off, recording the change itself.
 *
 * The opt-out event is captured *before* the client is torn down, so the last
 * thing the project hears from this installation is that it asked to stop.
 * Returns the value to persist.
 */
export function setEnabled(enabled: boolean): void {
  if (enabled) {
    if (permittedInThisRun()) start()
    capture({ name: 'analytics_opt_in' })
  } else {
    capture({ name: 'analytics_opt_out' })
    void stop()
  }
}

/**
 * Flushes on the way out.
 *
 * Without this the whole of the last session is lost: `posthog-node` batches,
 * and a batch that has not reached `flushAt` when the process exits is simply
 * gone. Awaited from `before-quit`.
 */
export async function shutdownAnalytics(): Promise<void> {
  await stop()
}

/**
 * Whether there is a client holding events that a quit would lose.
 *
 * Exists so the quit path can leave itself entirely alone for the users who
 * declined: without it, every quit by every user defers through a promise race
 * and leaves a two-second timer pending, to flush a client that was never
 * constructed.
 */
export function hasPendingAnalytics(): boolean {
  return client !== null
}
